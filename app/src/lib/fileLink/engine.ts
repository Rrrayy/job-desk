/**
 * 文件联动写入引擎（D8 第 1/3/4 层）。
 *
 * 三层职责压在一个模块里，因为它们共享同一份「此刻文件是什么样」的状态，
 * 拆开就会出现「队列以为文件是 A、冲突检测以为是 B」的竞态。
 *
 * 1. **per-filename 写入队列，深度 1**：连续保存 10 次只落最后一版。
 *    中间态没有保存价值 —— 这是文件而不是数据库事务，用户要的是「最终一致」。
 * 2. **原子提交**：`createWritable({ keepExistingData: true })` + `write` + `close`。
 *    `close()` 才是提交点；`write` 期间断电由 write-ahead buffer 兜（见 pending.ts）。
 * 3. **冲突检测**：写入前重读文件算 hash。hash 不一致 → **不写**，
 *    另存 `data.conflict-YYYYMMDD-HHMMSS.json`，把决定权交回用户。
 *
 * ★ 一条永远不会被打破的规则：**绝不静默覆盖用户文件**。
 *   宁可少写一次、多生成一个冲突副本，也不能让「外部改了文件」这件事被吞掉。
 *   冲突副本是用户唯一能看见真相的地方，所以它必须**先写成功**再动主文件。
 */

import { sha256Hex } from './hash';
import { type FileHandleLike, type PermissionOutcome, checkPermission, requestPermission } from './handle';
import { type PendingWrite, markReplayFailed, parsePending, serializePending } from './pending';

const PENDING_KEY = 'jobdesk.v1.fsPending';

/* ------------------------------ 待写缓冲的落盘 ------------------------------ */

function readPending(): PendingWrite | null {
  try {
    return parsePending(localStorage.getItem(PENDING_KEY));
  } catch {
    return null;
  }
}

function writePending(pending: PendingWrite | null): void {
  try {
    const text = serializePending(pending);
    if (text === null) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, text);
  } catch {
    // 存不下也不能拦住写入本身：pending 只是断电保险，不是写入门槛
  }
}

/** 给 UI 用：有没有一条等着重放的写入 */
export function peekPendingWrite(): PendingWrite | null {
  return readPending();
}

export function clearPendingWrite(): void {
  writePending(null);
}

/* -------------------------------- 写队列 -------------------------------- */

/**
 * 队列状态。`running` 保证同一时刻只有一个写事务，
 * `queued` 只留最新一版（深度 1，防抖合并）。
 */
interface QueueState {
  handle: FileHandleLike | null;
  running: boolean;
  queued: { text: string; nowIso: string } | null;
  lastResult: WriteOutcome | null;
  waiters: Array<(outcome: WriteOutcome | null) => void>;
}

const queue: QueueState = { handle: null, running: false, queued: null, lastResult: null, waiters: [] };

export type WriteOutcome =
  | { status: 'written'; hash: string }
  | { status: 'skipped'; reason: 'unchanged' }
  | { status: 'conflict'; conflictName: string; fileHash: string }
  | { status: 'need-permission'; permission: PermissionOutcome }
  | { status: 'failed'; error: string };

/** 绑定 / 解绑目标文件句柄（换文件时队列必须清空，否则会把旧内容写进新文件） */
export function bindHandle(handle: FileHandleLike | null): void {
  if (queue.handle === handle) return;
  queue.handle = handle;
  queue.queued = null;
}

/** 冲突副本的文件名：`data.conflict-YYYYMMDD-HHMMSS.json`（本地时区，用户看得懂） */
export function conflictFileName(nowIso: string): string {
  const date = new Date(nowIso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `data.conflict-${stamp}.json`;
}

/**
 * 冲突副本的落点。
 *
 * 句柄若是目录句柄，就在目录里建一个 `data.conflict-*.json`；
 * 若是文件句柄（本应用的默认形态：用户选的是 `data.json` 这个文件），
 * 就写同目录下的兄弟文件 —— 通过名字拼接 + 目录句柄拿不到的情况下，
 * 退回 `downloadFallback`（让用户下载下来，自己放到同一目录）。
 *
 * 这条退路必须存在：写不出冲突副本时，**主文件更不能动**。
 */
async function writeConflictCopy(
  handle: FileHandleLike,
  name: string,
  payload: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const dir = (handle as unknown as { parent?: unknown }).parent;
    if (dir && typeof (dir as { getFileHandle?: unknown }).getFileHandle === 'function') {
      const target = await (dir as { getFileHandle: (n: string, o?: { create?: boolean }) => Promise<FileHandleLike> }).getFileHandle(name, {
        create: true,
      });
      const writable = await target.createWritable({ keepExistingData: false });
      await writable.write(payload);
      await writable.close();
      return { ok: true };
    }
    return { ok: false, error: '浏览器没有暴露该文件的所在目录，无法自动写出冲突副本' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 真正的一次写入（不含队列）。
 *
 * 顺序不可调换：
 * ① 校验权限 → ② 读现状算 hash → ③ 一致就跳过（不产生无意义的 mtime 变化）
 * → ④ 不一致先写冲突副本 → ⑤ 写 pending → ⑥ 写主文件 → ⑦ 清 pending
 */
async function writeOnce(handle: FileHandleLike, text: string, nowIso: string): Promise<WriteOutcome> {
  const permission = await checkPermission(handle, 'readwrite');
  if (permission !== 'granted') return { status: 'need-permission', permission };

  let before: string;
  try {
    const file = await handle.getFile();
    before = await file.text();
  } catch (error) {
    return { status: 'failed', error: `读取目标文件失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 内容一模一样 → 什么都不做。这一条让「每 30 秒自动保存」不会把文件 mtime 刷成噪音
  if (before === text) return { status: 'skipped', reason: 'unchanged' };

  const beforeHash = await sha256Hex(before);
  const nextHash = await sha256Hex(text);

  /*
   * 冲突判定：以「上次我们写完之后记下的 hash」为基准。
   * 没有基准（首次连接）时不能判冲突 —— 用户刚选的文件本来就可能是外部生成的，
   * 把它当冲突会逼用户在第一次连接时就做一次无意义的决策。
   */
  const baseline = readBaseline();
  if (baseline && baseline.hash !== beforeHash) {
    const name = conflictFileName(nowIso);
    const payload = JSON.stringify(
      {
        note: '文件在工作台上次写入之后被外部修改过。这里保存的是外部版本，避免被覆盖。',
        detectedAt: nowIso,
        fileBefore: { hash: beforeHash, lastModified: new Date().toISOString() },
        workbenchBaseline: baseline,
        content: safeParse(before),
      },
      null,
      2,
    );
    const copied = await writeConflictCopy(handle, name, payload);
    if (!copied.ok) {
      // 副本写不出来 → 主文件一个字都不动，把原因交回去
      return { status: 'failed', error: `检测到冲突，但冲突副本写不出来（${copied.error}），已放弃本次写入` };
    }
    writePending({ contentHash: beforeHash, payload: text, createdAt: nowIso, status: 'pending', attempts: 0 });
    return { status: 'conflict', conflictName: name, fileHash: beforeHash };
  }

  writePending({ contentHash: beforeHash, payload: text, createdAt: nowIso, status: 'pending', attempts: 0 });

  try {
    // keepExistingData: true 是规范要求的「补丁式」写法：
    // 我们不 truncate，直接从头写满并 close，close 才提交
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.write(text);
    // 旧文件更长时必须截断，否则尾巴会残留成一段坏 JSON
    if (typeof writable.truncate === 'function') await writable.truncate(text.length);
    await writable.close();
  } catch (error) {
    // pending 留着，下次启动按 decideReplay 处理
    return { status: 'failed', error: `写入失败：${error instanceof Error ? error.message : String(error)}` };
  }

  writePending(null);
  writeBaseline({ hash: nextHash, at: nowIso });
  return { status: 'written', hash: nextHash };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/* ------------------------------ 基准 hash ------------------------------ */

/**
 * 「上一次由工作台写入后，文件应该长什么样」。
 *
 * 为什么不直接用文件自身的 hash 当基准：那样永远等于「当前文件」，
 * 冲突检测就失效了 —— 外部一改，我们再一读，基准立刻跟着变成外部版本。
 * 基准必须是**我们自己的写入动作留下的脚印**。
 */
const BASELINE_KEY = 'jobdesk.v1.fsBaseline';

function readBaseline(): { hash: string; at: string } | null {
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.hash !== 'string' || typeof value.at !== 'string') return null;
    return { hash: value.hash, at: value.at };
  } catch {
    return null;
  }
}

function writeBaseline(value: { hash: string; at: string }): void {
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(value));
  } catch {
    // 记不住基准只是让下次连接时少一次冲突判定，不影响正确性
  }
}

/** 重新连接文件时调用：清掉旧基准，避免拿上一个文件的 hash 判新文件 */
export function resetBaseline(): void {
  try {
    localStorage.removeItem(BASELINE_KEY);
  } catch {
    // 清不掉就交给下一次写入覆盖
  }
}

/**
 * 建立基准但不写文件。
 *
 * 用在「用户选择继续使用文件里的版本」这一支：我们接受了外部内容，
 * 于是把基准对齐到当前文件，下一次保存才不会立刻又报同一个冲突。
 */
export async function establishBaseline(handle: FileHandleLike, nowIso: string): Promise<string | null> {
  try {
    const file = await handle.getFile();
    const hash = await sha256Hex(await file.text());
    writeBaseline({ hash, at: nowIso });
    return hash;
  } catch {
    return null;
  }
}

/* ------------------------------ 队列调度 ------------------------------ */

/**
 * 请求写入（不等待）。同一时刻只有一个写事务在跑，
 * 期间到来的新请求只覆盖 `queued`，跑完再取最新的那一版。
 */
export function requestWrite(text: string, nowIso: string = new Date().toISOString()): void {
  queue.queued = { text, nowIso };
  void drainQueue();
}

/** 等待队列跑空（保存前 / 导出前 / 测试用） */
export function whenQueueIdle(): Promise<WriteOutcome | null> {
  if (!queue.running && !queue.queued) return Promise.resolve(queue.lastResult);
  return new Promise((resolve) => {
    queue.waiters.push(() => resolve(queue.lastResult));
  });
}

async function drainQueue(): Promise<void> {
  if (queue.running) return;
  queue.running = true;
  try {
    while (queue.queued) {
      const job = queue.queued;
      queue.queued = null;
      const handle = queue.handle;
      if (!handle) {
        queue.lastResult = { status: 'failed', error: '还没有连接文件' };
        continue;
      }
      queue.lastResult = await writeOnce(handle, job.text, job.nowIso);
    }
  } finally {
    queue.running = false;
    const waiters = queue.waiters.splice(0);
    for (const resolve of waiters) resolve(queue.lastResult);
  }
}

/* ------------------------------ 重放 ------------------------------ */

export type ReplayOutcome =
  | { status: 'none' }
  | { status: 'replayed'; hash: string }
  | { status: 'conflict'; conflictName: string }
  | { status: 'giveUp'; reason: string }
  | { status: 'dropped'; reason: string }
  | { status: 'failed'; error: string };

/**
 * 重放一条中断的写入（D8 第 2 层）。
 *
 * 触发时机只有两个：应用启动、以及权限重新获得之后。
 * **不在渲染过程中调用** —— 它要读文件、写文件，必须是用户可感知的显式动作。
 */
export async function replayPending(handle: FileHandleLike, nowIso: string): Promise<ReplayOutcome> {
  const pending = readPending();
  if (!pending) return { status: 'none' };

  let currentHash: string;
  try {
    const file = await handle.getFile();
    currentHash = await sha256Hex(await file.text());
  } catch (error) {
    return { status: 'failed', error: `重放前读取文件失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 依赖 decideReplay 的纯函数判断，避免「重放规则」散落在 IO 代码里
  const { decideReplay } = await import('./pending');
  const decision = decideReplay(pending, currentHash, nowIso);

  if (decision.action === 'drop') {
    writePending(null);
    return { status: 'dropped', reason: decision.reason };
  }
  if (decision.action === 'giveUp') {
    // 标记为 failed 保留 30 天，不删 payload —— 这是用户唯一的人工恢复来源
    writePending({ ...pending, status: 'failed', lastError: decision.reason });
    return { status: 'giveUp', reason: decision.reason };
  }
  if (decision.action === 'conflict') {
    const name = conflictFileName(nowIso);
    const copied = await writeConflictCopy(
      handle,
      name,
      JSON.stringify(
        {
          note: '检测到一次中断的写入，但文件此后被外部修改，因此没有重放。这里保存的是待写入的内容，供人工取舍。',
          detectedAt: nowIso,
          pending,
        },
        null,
        2,
      ),
    );
    if (!copied.ok) {
      return { status: 'failed', error: `冲突副本写不出来：${copied.error}` };
    }
    // 冲突处理后清掉 pending：内容已经在副本里，留着会在每次启动重复报同一个冲突
    writePending(null);
    return { status: 'conflict', conflictName: name };
  }

  const result = await writeOnce(handle, pending.payload, nowIso);
  if (result.status === 'written') return { status: 'replayed', hash: result.hash };
  if (result.status === 'skipped') return { status: 'replayed', hash: currentHash };
  if (result.status === 'conflict') return { status: 'conflict', conflictName: result.conflictName };

  const updated = markReplayFailed(pending, result.status === 'failed' ? result.error : '权限不足', nowIso);
  writePending(updated);
  return { status: 'failed', error: result.status === 'failed' ? result.error : '权限不足，无法重放' };
}

/**
 * 只读锁定（三出口）的判定（D8 收尾）。
 *
 * 三个触发源：文件解析失败、schema 不兼容、写入权限丢失。
 * 三种出口：下载原始文件 / 重试 / 另存为新文件。
 * **原始数据不自动修改或删除** —— 这条是硬承诺，所以这里的返回值只描述状态，
 * 不携带任何「修复动作」。
 */
export type ReadOnlyReason = 'parse-failed' | 'schema-incompatible' | 'permission-lost';

export const READ_ONLY_EXITS = ['download', 'retry', 'save-as'] as const;
export type ReadOnlyExit = (typeof READ_ONLY_EXITS)[number];

export interface ReadOnlyState {
  active: boolean;
  reason: ReadOnlyReason | null;
  /** 给用户看的一句话，说明为什么现在是只读 */
  message: string;
}

export function describeReadOnly(reason: ReadOnlyReason | null): ReadOnlyState {
  if (reason === null) return { active: false, reason: null, message: '' };
  const message =
    reason === 'parse-failed'
      ? '联动文件的内容读不出来（不是合法 JSON）。已切换为只读，你的原始文件一个字都没动。'
      : reason === 'schema-incompatible'
        ? '联动文件的数据格式与当前版本不兼容。已切换为只读，你的原始文件一个字都没动。'
        : '浏览器收回了对这个文件的写入权限。已切换为只读，你的原始文件一个字都没动。';
  return { active: true, reason, message };
}

/** 权限重请求的入口（必须在 click 里调） */
export async function retryPermission(handle: FileHandleLike): Promise<PermissionOutcome> {
  return requestPermission(handle, 'readwrite');
}
