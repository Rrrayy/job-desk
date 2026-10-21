/**
 * 加密（D10）回归。
 *
 * 这一组测的是「**错的时候会不会安静地给出错的东西**」——
 * 加密功能最可怕的失败不是报错，而是「解出一段看起来像明文的垃圾」。
 *
 * 守的六条：
 * 1. 往返正确（含中文 / emoji / 超长）
 * 2. IV 不复用：同一份明文加密两次，iv 与 ciphertext 都不同
 * 3. salt 不复用：同一口令两次加密，salt 不同
 * 4. 口令错 → 报错，且**不返回任何明文**
 * 5. 密文被改一个字节 → 报错（GCM 认证失败）
 * 6. 信封强度校验：iterations 过低 / 算法不对 / 缺字段 → 一律拒绝
 */

import { describe, expect, it } from 'vitest';
import {
  ENCRYPTION_ITERATIONS,
  ENCRYPTION_IV_BYTES,
  assessPassword,
  decryptText,
  detectCryptoCapability,
  encryptText,
  isEncryptedEnvelope,
  parseEnvelope,
} from './crypto';

const NOW = '2026-10-21T10:00:00.000Z';
/** 测试里用固定的低迭代数会绕过强度检查，所以直接用真实值 —— 派生一次约 0.3~1 s */
const PASSWORD = 'correct horse battery staple';

describe('D10 · 加密（AES-256-GCM + PBKDF2）', () => {
  it('能力探测：node 20+ 有 subtle，且无 window 时不算 insecure', () => {
    expect(detectCryptoCapability()).toBe('available');
  });

  it('往返正确（中文 / emoji / 换行都原样回来）', async () => {
    const plain = JSON.stringify({ 公司: '字节跳动', note: '一面 🚀\n二面', n: 42 });
    const encrypted = await encryptText(plain, PASSWORD, NOW);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;

    // 外层必须是可读 JSON，且标明自己加密了 —— 用户不会把它当坏文件删掉
    expect(isEncryptedEnvelope(encrypted.value)).toBe(true);
    const envelope = JSON.parse(encrypted.value) as Record<string, unknown>;
    expect(envelope.cipher).toBe('AES-256-GCM');
    expect(envelope.kdf).toBe('PBKDF2-SHA256');
    expect(envelope.iterations).toBe(ENCRYPTION_ITERATIONS);
    expect(envelope.ciphertext).not.toContain('字节');

    const decrypted = await decryptText(encrypted.value, PASSWORD);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) return;
    expect(decrypted.value).toBe(plain);
  });

  it('★ IV 绝不复用：同一明文同一口令加密两次，iv 与 ciphertext 都不同', async () => {
    const first = await encryptText('{"a":1}', PASSWORD, NOW);
    const second = await encryptText('{"a":1}', PASSWORD, NOW);
    if (!first.ok || !second.ok) throw new Error('加密失败');
    const a = JSON.parse(first.value) as Record<string, string>;
    const b = JSON.parse(second.value) as Record<string, string>;
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // iv 长度必须是 12 字节（base64 后 16 字符）
    expect(atob(a.iv)).toHaveLength(ENCRYPTION_IV_BYTES);
  });

  it('salt 也不复用：同一口令两次加密，salt 不同', async () => {
    const first = await encryptText('x', PASSWORD, NOW);
    const second = await encryptText('x', PASSWORD, NOW);
    if (!first.ok || !second.ok) throw new Error('加密失败');
    expect((JSON.parse(first.value) as Record<string, string>).salt).not.toBe(
      (JSON.parse(second.value) as Record<string, string>).salt,
    );
  });

  it('★ 口令错 → 报错，且绝不返回任何明文片段', async () => {
    const encrypted = await encryptText('{"机密":"这是不该泄漏的内容"}', PASSWORD, NOW);
    if (!encrypted.ok) throw new Error('加密失败');

    const wrong = await decryptText(encrypted.value, 'wrong password');
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error).toContain('口令');
    expect(wrong.error).not.toContain('不该泄漏');
  });

  it('★ 密文被改一个字节 → GCM 认证失败，拒绝解密', async () => {
    const encrypted = await encryptText('{"a":1}', PASSWORD, NOW);
    if (!encrypted.ok) throw new Error('加密失败');
    const envelope = JSON.parse(encrypted.value) as Record<string, string>;
    const raw = atob(envelope.ciphertext);
    // 改中间一个字节，并保持 base64 可解
    const bytes = raw.split('');
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = String.fromCharCode(bytes[middle].charCodeAt(0) ^ 0xff);
    envelope.ciphertext = btoa(bytes.join(''));

    const tampered = await decryptText(JSON.stringify(envelope), PASSWORD);
    expect(tampered.ok).toBe(false);
  });

  it('空口令直接拒绝（不生成一个「没有密码的加密文件」）', async () => {
    const result = await encryptText('x', '', NOW);
    expect(result.ok).toBe(false);
  });

  it('iterations 过低 / 算法不对 / 缺字段 → 一律拒绝', () => {
    const base = {
      app: 'jobdesk',
      encrypted: true,
      cipher: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: 600_000,
      salt: 'c2FsdA==',
      iv: 'aXZpdml2aXZpdg==',
      ciphertext: 'Y2lwaGVy',
      createdAt: NOW,
    };
    expect(parseEnvelope(JSON.stringify(base)).ok).toBe(true);

    expect(parseEnvelope(JSON.stringify({ ...base, iterations: 1 })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ ...base, cipher: 'AES-128-CBC' })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ ...base, kdf: 'argon2id' })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ ...base, iv: '' })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ ...base, encrypted: false })).ok).toBe(false);
    expect(parseEnvelope('不是 JSON').ok).toBe(false);
  });

  it('isEncryptedEnvelope 只看外层，不需要口令', () => {
    expect(isEncryptedEnvelope('{"encrypted":true}')).toBe(true);
    expect(isEncryptedEnvelope('  {"encrypted":true}')).toBe(true);
    expect(isEncryptedEnvelope('{"encrypted":false}')).toBe(false);
    expect(isEncryptedEnvelope('{"settings":{}}')).toBe(false);
    expect(isEncryptedEnvelope('坏文本')).toBe(false);
  });

  it('口令强度只给建议，不拦人', () => {
    expect(assessPassword('123').level).toBe('weak');
    expect(assessPassword('abcdefghij').level).toBe('fair');
    expect(assessPassword('Tr0ub4dor&3xyz').level).toBe('strong');
    // 再弱也返回结果，不抛错
    expect(assessPassword('').level).toBe('weak');
  });
});
