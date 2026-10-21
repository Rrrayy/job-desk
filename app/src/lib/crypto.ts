/**
 * 可选加密（D10）：AES-256-GCM + PBKDF2-SHA256。
 *
 * ★ 为什么是 PBKDF2 而不是路线图里写的 Argon2id（用户 2026-10-21 拍板）：
 *   Argon2id 需要引入第三方库（约 30–60 KB，且是一个原生/WASM 依赖），
 *   与本项目「单文件、零外部运行时依赖、file:// 双击可用」的硬承诺直接冲突。
 *   PBKDF2-SHA256 是 Web Crypto 原生实现，零体积、无需 polyfill。
 *   代价必须写清楚：**抗 GPU 暴力破解能力弱于 Argon2id**，
 *   所以把迭代次数拉到 60 万（OWASP 2023 对 PBKDF2-SHA256 的建议值）。
 *   低端手机上派生约 0.5–1.5 秒，这个等待是**故意的**。
 *
 * ★ 三条不可妥协的实现约束：
 *   1. **每次加密生成新的 12 字节随机 IV，绝不复用**。
 *      GCM 下 IV 复用会直接泄漏明文异或值，是整段加密作废级别的错误。
 *   2. **认证失败必须抛错**，绝不返回「看起来像明文」的东西。
 *      GCM 的 tag 校验就是「这个文件没被改过」的唯一证据。
 *   3. **加密是可选的，默认关闭**（用户拍板）。没开启时走的是原来的纯 JSON 路径，
 *      一个字节都不变 —— 不能因为加了功能就让老用户的文件格式变了。
 *
 * ★ 诚实声明（设置页要原样展示）：
 *   前端加密**不能**抵御 XSS 或恶意扩展对运行时内存的攻击 ——
 *   解密后的明文必然在内存里，也必然在渲染进程里。
 *   它的作用边界是「备份文件落到网盘 / U 盘 / 别人的电脑上时不被直接读走」。
 */

/*
 * 存储格式（**必须是纯 JSON**，因为应用要能在没有密码时判断「这是不是加密文件」）：
 *
 * {
 *   "app": "jobdesk",
 *   "encrypted": true,
 *   "cipher": "AES-256-GCM",
 *   "kdf": "PBKDF2-SHA256",
 *   "iterations": 600000,
 *   "salt": "<base64, 16 bytes>",
 *   "iv": "<base64, 12 bytes>",
 *   "ciphertext": "<base64>",
 *   "createdAt": "2026-10-21T10:00:00.000Z"
 * }
 *
 * 外层仍是 JSON 有一个额外好处：用户用文本编辑器打开时看到的不是乱码，
 * 而是「这是一份加密备份」，不会误以为文件损坏而删掉它。
 */

export const ENCRYPTION_ITERATIONS = 600_000;
export const ENCRYPTION_SALT_BYTES = 16;
export const ENCRYPTION_IV_BYTES = 12;
export const ENCRYPTION_CIPHER = 'AES-256-GCM';
export const ENCRYPTION_KDF = 'PBKDF2-SHA256';

/** 加密信封（见上方格式说明） */
export interface EncryptedEnvelope {
  app: 'jobdesk';
  encrypted: true;
  cipher: typeof ENCRYPTION_CIPHER;
  kdf: typeof ENCRYPTION_KDF;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: string;
}

export type CryptoOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 加密能力探测。
 *
 * `crypto.subtle` 只在安全上下文（https / localhost / file://）存在。
 * 本应用的主场景是 file://，可用；但 http 自建服务器上**不可用**，
 * 这时必须老老实实告诉用户「换 https 或换浏览器」，而不是给一个点了没反应的开关。
 */
export function detectCryptoCapability(): 'available' | 'insecure' | 'unsupported' {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.importKey !== 'function') return 'unsupported';
  const g = globalThis as unknown as { isSecureContext?: boolean };
  if (g.isSecureContext === false) return 'insecure';
  return 'available';
}

/* ------------------------------ base64 编解码 ------------------------------ */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ------------------------------ 密钥派生 ------------------------------ */

/**
 * PBKDF2-SHA256 → AES-256-GCM 的 CryptoKey。
 *
 * `extractable: false` 是硬要求：这把 key 只能用来加解密，
 * 不能被脚本导出成字节数组。配合「口令只在内存里、不进任何 storage」，
 * 构成这个功能的全部防护面。
 */
async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const material = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* ------------------------------ 加密 / 解密 ------------------------------ */

/**
 * 加密一段明文。
 *
 * ★ 每次调用都会新生成 salt 与 IV。salt 每次换是因为「同一个口令两代备份的
 *   派生结果不同」；IV 每次换是因为 GCM 下它**不许重复**，哪怕口令相同。
 */
export async function encryptText(plain: string, password: string, nowIso: string): Promise<CryptoOutcome<string>> {
  const capability = detectCryptoCapability();
  if (capability === 'unsupported') {
    return { ok: false, error: '当前浏览器没有 Web Crypto 支持，无法启用加密' };
  }
  if (capability === 'insecure') {
    return { ok: false, error: '加密只在 https 或本地打开时可用（浏览器限制），请换 https 地址或直接双击打开文件' };
  }
  if (!password) return { ok: false, error: '口令不能为空' };

  try {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(ENCRYPTION_SALT_BYTES));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(ENCRYPTION_IV_BYTES));
    const key = await deriveKey(password, salt, ENCRYPTION_ITERATIONS);
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      new TextEncoder().encode(plain),
    );

    const envelope: EncryptedEnvelope = {
      app: 'jobdesk',
      encrypted: true,
      cipher: ENCRYPTION_CIPHER,
      kdf: ENCRYPTION_KDF,
      iterations: ENCRYPTION_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      createdAt: nowIso,
    };
    return { ok: true, value: JSON.stringify(envelope, null, 2) };
  } catch (error) {
    return { ok: false, error: `加密失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 解密。**认证失败（口令错 / 文件被改）必须返回错误，绝不返回半截明文。**
 *
 * 这里刻意不区分「口令错」与「文件被篡改」：GCM 的 tag 校验失败时两者无法区分，
 * 硬要分开只能靠猜。文案里把两种可能都说出来，比给一个假的精确答案更诚实。
 */
export async function decryptText(payload: string, password: string): Promise<CryptoOutcome<string>> {
  const capability = detectCryptoCapability();
  if (capability === 'unsupported') {
    return { ok: false, error: '当前浏览器没有 Web Crypto 支持，无法解密这份备份' };
  }
  if (!password) return { ok: false, error: '请输入口令' };

  const parsed = parseEnvelope(payload);
  if (!parsed.ok) return parsed;

  try {
    const envelope = parsed.value;
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const key = await deriveKey(password, salt, envelope.iterations);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      base64ToBytes(envelope.ciphertext) as unknown as BufferSource,
    );
    return { ok: true, value: new TextDecoder().decode(plain) };
  } catch {
    return {
      ok: false,
      error: '解密失败：口令不对，或者这份备份在保存之后被改动过。两种情况下数据都不会被打开。',
    };
  }
}

/* ------------------------------ 信封识别 ------------------------------ */

/**
 * 判断一段文本是不是加密备份（**不需要口令**，只看外层信封）。
 *
 * 为什么必须能在没有口令时判断：打开一个加密备份时，应用要先知道
 * 「该弹输入口令的框」而不是「这是一份坏数据，进失败页」。
 */
export function isEncryptedEnvelope(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return false;
    return (parsed as Record<string, unknown>).encrypted === true;
  } catch {
    return false;
  }
}

/** 解析并校验信封字段（不做任何解密） */
export function parseEnvelope(text: string): CryptoOutcome<EncryptedEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '内容不是合法的 JSON，无法作为加密备份读取' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: '加密备份的顶层必须是一个对象' };
  }
  const value = parsed as Record<string, unknown>;
  if (value.encrypted !== true) return { ok: false, error: '这份文件没有 encrypted 标记，不是加密备份' };
  if (value.cipher !== ENCRYPTION_CIPHER) {
    return { ok: false, error: `不支持的加密算法：${String(value.cipher)}（当前只支持 ${ENCRYPTION_CIPHER}）` };
  }
  if (value.kdf !== ENCRYPTION_KDF) {
    return { ok: false, error: `不支持的密钥派生方式：${String(value.kdf)}（当前只支持 ${ENCRYPTION_KDF}）` };
  }
  const iterations = typeof value.iterations === 'number' ? Math.trunc(value.iterations) : 0;
  // 下限保护：一份 iterations=1 的信封等于没有加密，直接拒绝比「解开一个假安全文件」好
  if (iterations < 100_000) {
    return { ok: false, error: `密钥派生迭代次数过低（${iterations}），这份备份的安全性不可信，已拒绝解密` };
  }
  for (const field of ['salt', 'iv', 'ciphertext'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      return { ok: false, error: `加密备份缺少 ${field} 字段` };
    }
  }
  return {
    ok: true,
    value: {
      app: 'jobdesk',
      encrypted: true,
      cipher: ENCRYPTION_CIPHER,
      kdf: ENCRYPTION_KDF,
      iterations,
      salt: value.salt as string,
      iv: value.iv as string,
      ciphertext: value.ciphertext as string,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    },
  };
}

/* ------------------------------ 口令强度 ------------------------------ */

export interface PasswordStrength {
  level: 'weak' | 'fair' | 'strong';
  /** 给用户看的一句话，说明为什么是这个等级 */
  hint: string;
}

/**
 * 口令强度提示。**只给建议，不拦人** ——
 * 这是用户自己的备份文件，拦得住他只会让他换成一个更好猜的短口令。
 */
export function assessPassword(password: string): PasswordStrength {
  if (password.length < 8) {
    return { level: 'weak', hint: '少于 8 位，离线暴力破解只需要很短时间' };
  }
  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^a-zA-Z0-9]/.test(password));
  if (password.length >= 12 && classes >= 3) {
    return { level: 'strong', hint: '长度与字符种类都够，配合 60 万轮 PBKDF2 足以应对离线破解' };
  }
  if (password.length >= 10 || classes >= 2) {
    return { level: 'fair', hint: '够用，再加长到 12 位或补一种字符会更稳' };
  }
  return { level: 'weak', hint: '字符种类单一，建议混入数字或符号' };
}

/** 设置页与导出对话框共用的诚实声明（改文案时两处一起改） */
export const ENCRYPTION_DISCLAIMER =
  '前端加密不能抵御 XSS 或恶意浏览器扩展对运行时内存的攻击。它的作用是：' +
  '当备份文件落到网盘、U 盘或别人的电脑上时，没有口令就读不出内容。' +
  '口令不会被保存在任何地方，忘记口令后这份备份无法恢复。';
