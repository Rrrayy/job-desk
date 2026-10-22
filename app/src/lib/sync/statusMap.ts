/**
 * 平台原文案 → 内部状态（v0.8 起 10 个）。
 *
 * 原则（PRD §B.7）：
 * ① 只做事实，不做推断 —— 「邀请面试」是事实，约在第几轮只有用户知道，
 *    所以它映射到 `chatting` + 一条待办，**绝不自动进 `scheduled`**。
 * ② 可覆盖 —— settings.sync.statusMapOverrides 优先于内置规则。
 * ③ 映射不出来的不落库 —— 返回 null，由引擎落进「待归类」暂存。
 */

import type { Status } from '../../types';
import type { Confidence } from '../../adapters/types';

export type MapAction = 'fillAppliedAt' | 'todoInterview' | 'promptInterviewRecord';

export interface StatusRule {
  /** 顺序敏感：先匹配者胜 */
  re: RegExp;
  status: Status | null;
  action?: MapAction;
  confidence: Confidence;
  /** 一句话给用户看 */
  note: string;
}

/**
 * PRD §B.7 的 9 条（「沟通中」按「对方发过 / 只有我发过」拆成两条，
 * 纯文本识别不到发信方时统一按高置信度 chatting，见架构 §8-歧义 3）。
 * 顺序即优先级。
 * v0.8（PRD Q6 保守规则）：含「笔试」字样 → written（medium 置信），
 * 放头部 —— 真机样本到位后随 B1 校准。
 */
export const STATUS_RULES: StatusRule[] = [
  { re: /笔试/, status: 'written', confidence: 'medium', note: '平台显示进入笔试' },
  { re: /邀请面试|邀你面试|约面试/, status: 'chatting', action: 'todoInterview', confidence: 'high', note: '平台邀面了，去约时间' },
  { re: /已面试|面试完成|面试已结束/, status: 'interviewing', action: 'promptInterviewRecord', confidence: 'medium', note: '平台已面完，补一场面试记录' },
  { re: /已录用|发放\s*offer|已发\s*offer|offer/i, status: 'offer', confidence: 'high', note: '平台显示已录用' },
  { re: /已入职/, status: 'onboarded', confidence: 'high', note: '平台显示已入职' },
  { re: /不合适|已结束|不符合|暂不匹配/, status: 'rejected', confidence: 'high', note: '平台显示不合适' },
  { re: /已投递|简历已送达|已送达|已查看/, status: 'applied', action: 'fillAppliedAt', confidence: 'high', note: '平台已收简历' },
  { re: /沟通中/, status: 'chatting', confidence: 'high', note: '平台显示沟通中' },
];

export interface MappedStatus {
  status: Status | null;
  confidence: Confidence;
  action?: MapAction;
  note: string;
}

/**
 * overrides 的键 = 平台原文（去空白后精确匹配）。
 * 值是 `null` 表示「用户明确要求这条文案不映射」。
 */
export function mapPlatformStatus(
  platformStatusRaw: string | undefined,
  overrides: Record<string, Status | null>,
): MappedStatus {
  const raw = (platformStatusRaw ?? '').replace(/\s+/g, '');
  if (!raw) return { status: null, confidence: 'low', note: '平台没给状态' };

  const key = Object.keys(overrides).find((item) => item.replace(/\s+/g, '') === raw);
  if (key !== undefined) {
    const forced = overrides[key];
    return forced === null
      ? { status: null, confidence: 'low', note: '你设置了这个文案不映射' }
      : { status: forced, confidence: 'high', note: '按你的映射设置' };
  }
  for (const rule of STATUS_RULES) {
    if (rule.re.test(raw)) {
      return { status: rule.status, confidence: rule.confidence, action: rule.action, note: rule.note };
    }
  }
  return { status: null, confidence: 'low', note: '这个平台文案不认识，需要你归类' };
}

/**
 * 推进次序（架构 D-09）。与漏斗口径 `stageRankOf` **无关，不要互相替代**：
 * stageRankOf 回答「走到过第几步」；这张表回答「谁在谁后面」。
 *
 * rejected 排在 offer 之后：被拒可能发生在任何阶段（含 offer 后毁约）。
 * 若排在 interviewing 之前，「已约面 → 不合适」会被误判成「平台落后」而跳过，
 * 而这正是同步最该生效的一条。
 */
export const SYNC_STATUS_RANK: Record<Status, number> = {
  wishlist: 0,
  applied: 1,
  chatting: 2,
  written: 3,
  scheduled: 4,
  interviewing: 5,
  offer: 6,
  onboarded: 7,
  rejected: 8,
  dropped: 9,
};
