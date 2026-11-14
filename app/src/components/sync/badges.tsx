/**
 * 同步面板用的小标签：置信度 / 行类型 / 冲突 / 来源。
 * 全部零状态，纯展示 —— 方便在 Step2 / Step3 / StagingList 三处复用。
 */

import type { Confidence } from '../../adapters/types';
import type { PlannedRow } from '../../lib/sync/types';
import { cx } from '../../lib/util';

const CONFIDENCE_TEXT: Record<Confidence, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export function ConfidenceBadge({ level }: { level: Confidence }) {
  return (
    <span
      className={cx(
        'sync__badge',
        level === 'high' && 'sync__badge--high',
        level === 'medium' && 'sync__badge--medium',
        level === 'low' && 'sync__badge--low',
      )}
      title={`置信度：${CONFIDENCE_TEXT[level]}`}
    >
      {CONFIDENCE_TEXT[level]}
    </span>
  );
}

const KIND_TEXT: Record<PlannedRow['kind'], string> = {
  new: '新增',
  update: '更新',
  unchanged: '无变化',
  conflict: '冲突',
  staged: '待归类',
};

export function KindBadge({ kind }: { kind: PlannedRow['kind'] }) {
  return <span className={cx('sync__badge', `sync__badge--${kind}`)}>{KIND_TEXT[kind]}</span>;
}

export function kindText(kind: PlannedRow['kind']): string {
  return KIND_TEXT[kind];
}

/** 「来源：BOSS 同步 · 3/12 10:20」这类灰色小字 */
export function SourceLine({ text }: { text: string }) {
  return <span className="sync__source">{text}</span>;
}

export function BlockedHint({ row }: { row: PlannedRow }) {
  if (!row.blockedBy) return null;
  const text =
    row.blockedBy === 'user-edited'
      ? '你手改过，默认不覆盖'
      : row.blockedBy === 'platform-behind'
        ? '平台落后于你'
        : row.blockedBy === 'same-rank-diff'
          ? '同阶段说法不同'
          : '置信度低';
  return <span className="sync__badge sync__badge--warn">{text}</span>;
}
