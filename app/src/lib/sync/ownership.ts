/**
 * 字段 ownership 常量表 —— 同步引擎的「宪法」。
 *
 * 用 `Record<keyof Application, Ownership>` 做**编译期穷尽检查**：
 * 以后给 Application 加字段而忘了声明归属 → tsc 直接报错。
 * 这是本表最大的价值，**不要改成 Partial**。
 */

import type { Application, SyncableField } from '../../types';

/**
 * 七种归属：
 * - never                 平台永不写，用户也不能直接写（由写入器维护）
 * - user-only             永远以用户为准，平台永不触碰（主观判断 / 私有资产）
 * - fill-only             平台可覆盖，**仅当本地为空**（补全型）
 * - platform-later-only   平台可写，但仅当平台时间晚于本地
 * - platform-guarded      平台可写，但受映射/置信度/手改/推进次序四重约束
 * - platform-only         平台独占，用户不可见
 * - set-once              只在本地为空时按平台设定一次，之后不再改
 */
export type Ownership =
  | 'never'
  | 'user-only'
  | 'fill-only'
  | 'platform-later-only'
  | 'platform-guarded'
  | 'platform-only'
  | 'set-once';

export const FIELD_OWNERSHIP: Record<keyof Application, Ownership> = {
  id: 'never',
  companyId: 'never',
  createdAt: 'never',
  updatedAt: 'never',
  sync: 'platform-only',
  userEditedAt: 'user-only',

  // 平台可写（受约束）
  status: 'platform-guarded',
  statusChangedAt: 'platform-guarded',
  lastActivityAt: 'platform-later-only',
  appliedAt: 'fill-only',
  channel: 'set-once',

  // 补全型
  jobTitle: 'fill-only',
  jdUrl: 'fill-only',
  city: 'fill-only',
  salaryText: 'fill-only',
  /**
   * 截止日期是外部世界发布的事实（平台详情页上就写着），
   * 但用户手填的永远优先 —— 所以是 fill-only：**只在本地为空时**由平台补。
   * 目前没有适配器解析它，写在这里是为了让「加字段必须声明归属」这条编译期约束完整。
   */
  deadlineAt: 'fill-only',

  // 永远以用户为准（PRD §B.6 末行，逐条对应）
  jobType: 'user-only',
  priority: 'user-only',
  tags: 'user-only',
  resumeVersion: 'user-only',
  daysPerWeek: 'user-only',
  durationMonths: 'user-only',
  silenceOverride: 'user-only',
  rejectReason: 'user-only',
  rejectedAtRound: 'user-only',
  nextActionAt: 'user-only',
  /** 静音是纯个人意图（「这段时间别催我」），平台永远不该碰 */
  mutedUntil: 'user-only',
  /**
   * v0.5：回收站标记。**平台永不触碰**。
   * 否则会出现「你删掉的投递，下一次同步又被平台数据拉回来」这种灵异事件 ——
   * 从用户视角那就是「删不掉」，比不同步更让人绝望。
   */
  deletedAt: 'never',
};

/** 会被同步写到的字段（UI 预览表列顺序 = 这个顺序） */
export const SYNC_WRITABLE: SyncableField[] = [
  'status',
  'lastActivityAt',
  'appliedAt',
  'jobTitle',
  'city',
  'jdUrl',
  'salaryText',
  'channel',
];

/** 平台 → 渠道的一次性映射（custom 无法判断渠道 → other） */
export const CHANNEL_BY_PLATFORM = {
  boss: 'boss',
  shixiseng: 'shixiseng',
  nowcoder: 'nowcoder',
  custom: 'other',
} as const;
