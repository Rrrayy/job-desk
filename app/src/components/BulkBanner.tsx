/**
 * 体积水位常驻提示。
 *
 * 为什么要有它：localStorage 一般 5 MB（按 UTF-16 计约 2.5 M 字符），
 * 满了之后 `setItem` 会**静默失败**（多数浏览器抛 QuotaExceededError，部分只在控制台报）。
 * 用户以为存上了、其实没存 —— 这是最恶劣的一类 bug，所以这里必须显眼。
 */

import { BUDGET, formatBytes } from '../lib/budget';
import type { BudgetLevel } from '../lib/budget';

export interface BulkBannerProps {
  level: BudgetLevel;
  size: number;
  /** 打不开设置页时直接导出也算一步自救 */
  onExport: () => void;
  onOpenSettings: () => void;
}

export function BulkBanner({ level, size, onExport, onOpenSettings }: BulkBannerProps) {
  if (level === 'ok') return null;

  const percent = Math.min(100, Math.round((size / BUDGET.block) * 100));

  if (level === 'block') {
    return (
      <div className="banner banner--error">
        <strong>⚠ 数据已超过存储上限，这次改动没有保存成功</strong>
        <span>
          当前 {formatBytes(size)} / 上限约 {formatBytes(BUDGET.block)}（{percent}%）。
          请立刻导出备份，然后删掉不用的投递或较长的面经备注。
        </span>
        <div className="drawer__actions">
          <button type="button" className="btn btn--small btn--primary" onClick={onExport}>
            导出备份
          </button>
          <button type="button" className="btn btn--small" onClick={onOpenSettings}>
            去清理
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="banner banner--warn">
      <strong>存储占用偏高</strong>
      <span>
        当前 {formatBytes(size)}（约 {percent}% 上限）。数据都在你自己的浏览器里，
        建议先导出一份备份，再删掉不再关注的投递。
      </span>
      <div className="drawer__actions">
        <button type="button" className="btn btn--small" onClick={onExport}>
          导出备份
        </button>
        <button type="button" className="btn btn--small" onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </div>
  );
}
