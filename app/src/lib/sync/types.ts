/**
 * 合并引擎的 I/O 类型（架构 §2.3）。
 * 这一层是产品语义层：改字段 = 改产品行为，不属于「社区可贡献」的范围。
 */

import type {
  Application,
  DB,
  NoteSource,
  PlatformId,
  StagedReason,
  StagedSyncItem,
  Status,
  SyncableField,
} from '../../types';
import type { Confidence, NormalizedRecord } from '../../adapters/types';

export type MatchBy = 'externalId' | 'matchKey' | 'company+title' | 'company+emptyTitle';

export interface PlannedChange {
  field: SyncableField;
  from?: string;
  to?: string;
}

/** 一行计划。**UI 只读这个，不做任何推导** */
export interface PlannedRow {
  /** 稳定 UI key：`externalId|归一化公司|归一化岗位`（重复时追加 #n） */
  key: string;
  kind: 'new' | 'update' | 'unchanged' | 'conflict' | 'staged';
  /** 命中本地投递时的 id */
  targetAppId?: string;
  matchedBy?: MatchBy;
  /** 用于模糊匹配的相似度（0-1），仅 company+title 时存在 */
  similarity?: number;
  record: NormalizedRecord;
  /** 映射后的内部状态；null = 映射不出来 */
  mappedStatus: Status | null;
  /** 平台「想表达」但被 ownership 拦下的字段，UI 需要解释「为什么没写」 */
  changes: PlannedChange[];
  blockedBy?: 'user-edited' | 'platform-behind' | 'same-rank-diff' | 'low-confidence';
  /** kind==='conflict' 时填，供 UI 逐项选择 */
  conflict?: {
    field: 'status';
    local: Status;
    platform: Status;
    localRank: number;
    platformRank: number;
    /** 用户手改该字段的时间（PRD §B.5 硬规则 1 的判据） */
    userEditedAt?: string;
  };
  /** staged 行的暂存原因 */
  stagedReason?: StagedReason;
  /** staged/ambiguous 时的候选本地投递（UI 展示「有 N 条疑似」，合并时取第一个） */
  candidateAppIds?: string[];
  /** 默认是否勾选（PRD §B.5 硬规则 1/2） */
  defaultChecked: boolean;
  /** 用户最终是否勾选（默认 = defaultChecked；④ 确认前由 UI 覆盖） */
  checked?: boolean;
  /**
   * v0.7.2：staged 行被用户**手动指定状态**后置位。
   * 此时 kind 已改为 'new'、mappedStatus 为用户选的状态——按新增写入，不再进暂存区。
   * UI 据此显示「你手动指定了状态」而不是状态选择器。
   */
  manuallyResolved?: boolean;
  /** 给用户看的一句话解释：'你 3/10 手动改过'、'平台落后于你' */
  warnings: string[];
}

export interface MergeCounts {
  new: number;
  update: number;
  unchanged: number;
  conflict: number;
  staged: number;
}

export interface MergePlan {
  platform: PlatformId;
  capturedAt: string;
  /** 必须是 adapter.parse().records.length，UI 用它做「识别 N 条」 */
  parsedCount: number;
  /** 解析失败的条目，UI 必须显示出来（不许静默丢） */
  unparsed: { rawSnippet: string; reason: string }[];
  counts: MergeCounts;
  /** 不变式：counts 五项之和 === parsedCount（D-13） */
  rows: PlannedRow[];
}

/** 一次同步的撤销快照。**只存在内存**（与 StatusUndo 一致），刷新即失效 */
export interface SyncUndo {
  id: string;
  at: string;
  platform: PlatformId;
  /** 本次触碰过的投递。before === null 表示「本次新建」，撤销即删除 */
  apps: { appId: string; before: Application | null }[];
  /** 本次新建的公司 id（撤销时若已无投递引用则删除） */
  createdCompanyIds: string[];
  /** 本次写入的 note id，撤销时按 id 精确删除 */
  noteIds: string[];
  /** 本次新增到暂存区的 id */
  stagedAddedIds: string[];
  /** 本次从暂存区移除的条目（用户处理掉的），撤销时原样放回 */
  stagedRemoved: { id: string; item: StagedSyncItem }[];
  /** 用于生成 note 的上下文 */
  source: NoteSource;
}

export interface ApplyOptions {
  /** 用户最终勾选的行（含在 conflict 行上显式勾选 = 强制覆盖） */
  rows: PlannedRow[];
  now: string;
  capturedAt: string;
  platform: PlatformId;
  /**
   * 适配器解析失败的条目（QA D1）。
   *
   * 这些条目**没有对应的 PlannedRow**，所以必须单独传进来：
   * 引擎会把它们写进暂存区，用户在「待归类」里能看见原文、能补录、能丢弃。
   * 不传 = 静默丢，这正是 D1 的 bug。
   */
  unparsed?: { rawSnippet: string; reason: string }[];
}

export interface ApplyResult {
  db: DB;
  undo: SyncUndo;
  /** 实际写入条数，用于 ④ 的「将写入 N 条」 */
  written: number;
  /** 未勾选但需要保留到暂存区的条数 */
  staged: number;
  /** 暂存超上限被丢弃的条数（>0 时 UI 必须提示） */
  discarded: number;
}

/** 逐字段置信度取值（给 UI 的 badges 用） */
export function confidenceOf(record: NormalizedRecord, field: keyof NormalizedRecord): Confidence {
  return record.confidence[field] ?? 'medium';
}
