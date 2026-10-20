/**
 * 复盘内的二级 tab：`[数据][面经]`。
 *
 * 为什么不加一级 tab：底栏 5 个入口已经是「每天要用的频次上限」，
 * 面经是「面完当天才用」的低频功能，塞进复盘里既省位置又符合叙事（复盘 = 看数据 + 沉淀经验）。
 */

import type { InsightsTab } from '../../lib/api';

export interface InsightsTabsProps {
  tab: InsightsTab;
  onChange: (tab: InsightsTab) => void;
  /** 待复盘场次数，用来在「面经」上点一个未处理数 */
  pendingCount: number;
}

export function InsightsTabs({ tab, onChange, pendingCount }: InsightsTabsProps) {
  return (
    <div className="exp__tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'data'}
        className={tab === 'data' ? 'exp__tab exp__tab--active' : 'exp__tab'}
        onClick={() => onChange('data')}
      >
        数据
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'interview'}
        className={tab === 'interview' ? 'exp__tab exp__tab--active' : 'exp__tab'}
        onClick={() => onChange('interview')}
      >
        面经
        {pendingCount > 0 ? <span className="exp__tab-dot" title={`${pendingCount} 场面试待复盘`} /> : null}
      </button>
    </div>
  );
}
