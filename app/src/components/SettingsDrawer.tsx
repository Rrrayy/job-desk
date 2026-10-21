/**
 * 设置抽屉：阈值 / 每周目标 / 课程时间段 / 默认简历版本 / 示例数据 / 清空 / 导入导出。
 */

import { useMemo, useRef, useState } from 'react';
import type { AppApi } from '../lib/api';
import type { AppSettings, PlatformId } from '../types';
import { BUDGET, budgetLevelOf, formatBytes, measureDB } from '../lib/budget';
import { getLastExportAt, purgeRollbackPoints, rollbackPointsSize } from '../lib/storage';
import { PLATFORM_LABEL } from '../adapters/registry';
import { CommunityImport } from './interview/CommunityImport';

const PLATFORMS: PlatformId[] = ['boss', 'shixiseng', 'nowcoder', 'custom'];

export interface SettingsDrawerProps {
  api: AppApi;
  onClose: () => void;
  importError: string | null;
  onDismissError: () => void;
}

type NumberKey =
  | 'warnAfterDays'
  | 'staleAfterDays'
  | 'interviewResultWaitDays'
  | 'wishlistExpireDays'
  | 'weeklyApplyGoal';

export function SettingsDrawer({ api, onClose, importError, onDismissError }: SettingsDrawerProps) {
  const { db } = api;
  const settings = db.settings;
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmSample, setConfirmSample] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [rollbackSize, setRollbackSize] = useState(() => rollbackPointsSize());
  const [lastExportAt] = useState(() => getLastExportAt());

  /**
   * 备份提醒的口径：从未导出 = 提醒；超过 7 天 = 提醒。
   * 只做「温和提示」，不弹窗、不拦截操作 —— 工具不该在用户忙的时候挡路。
   */
  const backupDays = lastExportAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastExportAt).getTime()) / 86400000))
    : null;
  const staleBackup = backupDays === null || backupDays >= 7;
  const backupText =
    backupDays === null ? '从未导出' : backupDays === 0 ? '今天' : `${backupDays} 天前`;

  const patchNumber = (key: NumberKey, raw: string): void => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const value = Math.round(parsed);
    const next: Partial<AppSettings> = {};
    switch (key) {
      case 'warnAfterDays':
        next.warnAfterDays = value;
        break;
      case 'staleAfterDays':
        next.staleAfterDays = value;
        break;
      case 'interviewResultWaitDays':
        next.interviewResultWaitDays = value;
        break;
      case 'wishlistExpireDays':
        next.wishlistExpireDays = value;
        break;
      case 'weeklyApplyGoal':
        next.weeklyApplyGoal = value;
        break;
      default:
        break;
    }
    api.updateSettings(next);
  };

  const numberFields: Array<{ key: NumberKey; label: string }> = [
    { key: 'warnAfterDays', label: '该跟进（黄）' },
    { key: 'staleAfterDays', label: '已沉默（红）' },
    { key: 'interviewResultWaitDays', label: '等结果超时' },
    { key: 'wishlistExpireDays', label: '想投超期' },
    { key: 'weeklyApplyGoal', label: '每周投递目标' },
  ];

  /** 体积口径与 BulkBanner 完全一致：JSON.stringify(db).length 的字符数 */
  const dbSize = useMemo(() => measureDB(db), [db]);
  const budgetLevel = budgetLevelOf(dbSize);
  const budgetPercent = Math.min(100, Math.round((dbSize / BUDGET.block) * 100));
  const questionCount = db.questions.length;
  const noteCount = db.notes.length;

  const patchSync = (patch: Partial<AppSettings['sync']>): void => {
    api.updateSettings({ sync: { ...settings.sync, ...patch } });
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer drawer--settings" onClick={(event) => event.stopPropagation()}>
        <header className="drawer__head">
          <h2 className="drawer__title">设置</h2>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="drawer__body">
          <section className="drawer__section">
            <h3 className="drawer__section-title">沉默阈值（天）</h3>
            <p className="field__hint">
              内推 ×3 / 官网 ×2 / 其余 ×1；<strong>单独设置过阈值的公司不受此系数影响</strong>（按你填的天数算）。
            </p>
            <div className="drawer__grid">
              {numberFields.map((field) => (
                <label key={field.key} className="field field--narrow">
                  <span className="field__label">{field.label}</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    defaultValue={settings[field.key]}
                    onBlur={(event) => patchNumber(field.key, event.target.value)}
                  />
                </label>
              ))}
              <label className="field">
                <span className="field__label">默认简历版本</span>
                <input
                  className="input"
                  defaultValue={settings.defaultResumeVersion || ''}
                  placeholder="v3-前端-项目版"
                  onBlur={(event) => api.updateSettings({ defaultResumeVersion: event.target.value.trim() })}
                />
              </label>
            </div>
          </section>

          <section className="drawer__section">
            <h3 className="drawer__section-title">课表与日程</h3>
            <p className="field__hint">
              日历上可以标注任何事：课、组会、急事。面试和日程在同一天的具体时间段撞上了，会自动提醒冲突。
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  api.setView('calendar');
                  onClose();
                }}
              >
                去日历导入课表 / 记事情
              </button>
            </div>
            <p className="field__hint">
              当前共 {db.events.length} 条日程（{db.events.filter((event) => event.kind === 'course').length} 节课 ·{' '}
              {db.events.filter((event) => event.kind !== 'course').length} 件事）。
            </p>
          </section>

          <section className="drawer__section">
            <h3 className="drawer__section-title">数据</h3>
            <div className="btn-row">
              <button type="button" className="btn btn--small" onClick={() => fileRef.current?.click()}>
                导入 JSON
              </button>
              <button type="button" className="btn btn--small" onClick={api.exportData}>
                导出 JSON
              </button>
              <button type="button" className="btn btn--small" onClick={api.exportCsv}>
                导出 CSV
              </button>
              <button type="button" className="btn btn--small" onClick={api.exportIcs}>
                导出日历
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden-file"
                onChange={(event) => {
                  const file = event.target.files && event.target.files[0];
                  if (file) api.importData(file);
                  event.target.value = '';
                }}
              />
            </div>
            {importError ? (
              <div className="notice notice--danger">
                <strong>导入失败</strong>
                <p>{importError}</p>
                <button type="button" className="link-btn" onClick={onDismissError}>
                  知道了
                </button>
              </div>
            ) : null}
            <p className="field__hint">
              数据存在这个浏览器的 localStorage（key: jobdesk.v1）。换电脑请先导出再导入。
            </p>
            <p className="field__hint">
              <strong>只有 JSON 能导入回来</strong>。CSV 给 Excel 看、日历给系统日历看，两个都是单向的，
              别拿它们当备份。
            </p>

            <div className="data-card">
              <div>
                <div className="data-card__title">示例数据（8 家，覆盖 7 种状态）</div>
                <div className="data-card__text">
                  {confirmSample
                    ? '加载示例会替换掉当前所有数据，确定吗？'
                    : '想快速看看产品长什么样，可以加载一份示例。'}
                </div>
              </div>
              {confirmSample ? (
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn--small btn--primary"
                    onClick={() => {
                      api.loadSampleData();
                      setConfirmSample(false);
                    }}
                  >
                    确定加载
                  </button>
                  <button type="button" className="btn btn--small" onClick={() => setConfirmSample(false)}>
                    取消
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn--small" onClick={() => setConfirmSample(true)}>
                  加载示例数据
                </button>
              )}
            </div>

            <div className="data-card data-card--danger">
              <div>
                <div className="data-card__title">回到初始状态</div>
                <div className="data-card__text">
                  {confirmClear
                    ? '这一步不可撤销：清空全部投递、面经、课表日程，设置恢复出厂。建议先导出备份。'
                    : `当前共 ${db.applications.length} 条投递 · ${db.events.length} 条日程。`}
                </div>
              </div>
              {confirmClear ? (
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn--small btn--danger"
                    onClick={() => {
                      api.clearAllData();
                      setConfirmClear(false);
                    }}
                  >
                    确认回到初始状态
                  </button>
                  <button type="button" className="btn btn--small" onClick={() => setConfirmClear(false)}>
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn--small btn--danger-ghost"
                  onClick={() => setConfirmClear(true)}
                >
                  回到初始状态
                </button>
              )}
            </div>
          </section>

          <section className="drawer__section">
            <div className="drawer__section-head">
              <h3 className="drawer__section-title">平台同步</h3>
              <span className="muted">暂存区 {db.staging.length} 条</span>
            </div>
            <p className="field__hint">
              同步只读你自己屏幕上的内容：不替你登录、不替你发请求、不在后台跑。
              <strong>它仍然可能被平台判定为异常使用</strong>，所以第一次打开会让你确认一次风险。
            </p>
            <div className="drawer__grid">
              <label className="field field--narrow">
                <span className="field__label">默认平台</span>
                <select
                  className="select"
                  value={settings.sync.defaultPlatform}
                  onChange={(event) => patchSync({ defaultPlatform: event.target.value as PlatformId })}
                >
                  {PLATFORMS.map((id) => (
                    <option key={id} value={id}>
                      {PLATFORM_LABEL[id]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field field--narrow">
                <span className="field__label">平台时间刷新「最后活动」</span>
                <select
                  className="select"
                  value={settings.sync.autoRefreshActivity ? 'on' : 'off'}
                  onChange={(event) => patchSync({ autoRefreshActivity: event.target.value === 'on' })}
                >
                  <option value="on">开（推荐）</option>
                  <option value="off">关（只按我自己记的时间算）</option>
                </select>
              </label>
            </div>
            <div className="drawer__actions">
              <button type="button" className="btn btn--small" onClick={api.openSync}>
                打开同步面板
              </button>
              {settings.sync.riskAckAt ? (
                <button
                  type="button"
                  className="btn btn--small btn--danger-ghost"
                  onClick={() => {
                    patchSync({ riskAckAt: undefined });
                    api.toast('已重置风险确认：下次打开同步会重新让你读一遍');
                  }}
                >
                  重置风险确认
                </button>
              ) : null}
            </div>
            <p className="field__hint">
              {settings.sync.riskAckAt
                ? `已于 ${formatLocalMinute(settings.sync.riskAckAt)} 确认过风险（之后不再弹窗）`
                : '还没确认过风险 —— 下次打开同步面板会先让你读一段说明，勾选后才能继续。'}
            </p>
            {settings.lastMigration ? (
              <p className="field__hint">
                数据从 v{settings.lastMigration.from} 迁到 v{settings.lastMigration.to}（{settings.lastMigration.at.slice(0, 10)}）。
                迁移前的原始数据还留在 <code>{settings.lastMigration.backupKey}</code>，保留 30 天。
              </p>
            ) : null}
          </section>

          <section className="drawer__section">
            <div className="drawer__section-head">
              <h3 className="drawer__section-title">社区题库（可选）</h3>
              <span className="muted">离线导入</span>
            </div>
            <CommunityImport api={api} />
          </section>

          <section className="drawer__section">
            <div className="drawer__section-head">
              <h3 className="drawer__section-title">存储占用</h3>
              <span className="muted">
                {budgetLevel === 'ok' ? '正常' : budgetLevel === 'warn' ? '接近上限' : '已超上限'}
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-row__label">本地数据</span>
              <div className="stat-row__track">
                <div
                  className={budgetLevel === 'block' ? 'stat-row__bar stat-row__bar--alt' : 'stat-row__bar'}
                  style={{ width: `${Math.max(2, budgetPercent)}%` }}
                />
              </div>
              <span className="stat-row__value">
                {formatBytes(dbSize)}
                <span className="stat-row__sub">{budgetPercent}%</span>
              </span>
            </div>
            <p className="field__hint">
              上限按 {formatBytes(BUDGET.block)} 估算（localStorage 通常 5 MB 左右，写满之后 setItem
              会直接失败 —— 那才是最恶劣的一类 bug，所以这里把水位摆出来）。
              当前 {db.applications.length} 条投递 · {db.experiences.length} 场面经 · {questionCount} 道题 ·{' '}
              {noteCount} 条时间线。
            </p>
            <p className="field__hint">换电脑、清浏览器缓存之前，先在上面「导出 JSON」存一份。</p>
          </section>

          <section className="drawer__section">
            <h3 className="drawer__section-title">关于</h3>
            <div className="about-list">
              <div className="about-row">
                <span>版本</span>
                <strong>v{__APP_VERSION__}</strong>
              </div>
              <div className="about-row">
                <span>上次备份</span>
                <strong className={staleBackup ? 'about-row__value--warn' : undefined}>{backupText}</strong>
              </div>
              <div className="about-row">
                <span>迁移回滚点</span>
                <strong>{rollbackSize > 0 ? formatBytes(rollbackSize) : '无'}</strong>
              </div>
            </div>
            {staleBackup ? (
              <p className="field__hint">
                距离上次导出已经超过一周（或从未导出）。清缓存、换浏览器、无痕模式都会让本地数据消失，
                点上面的「导出 JSON」存一份，十秒的事。
              </p>
            ) : null}
            {rollbackSize > 0 ? (
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    const freed = purgeRollbackPoints();
                    setRollbackSize(0);
                    api.toast(
                      freed.keys > 0
                        ? `已清理 ${freed.keys} 份迁移回滚点，释放约 ${formatBytes(freed.bytes)}`
                        : '没有可清理的回滚点',
                    );
                  }}
                >
                  清理迁移回滚点
                </button>
              </div>
            ) : null}
            <p className="field__hint">
              数据只存在本地，不上传任何服务器、不发任何网络请求。
              <br />
              快捷键：N 新建 / 1-5 切视图 / ⌘K 搜索 / ⌘Z 撤销（可连按，最多 10 步）/ ⇧⌘Z 或 Ctrl+Y 重做 / Esc 关闭浮层。
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}

/** ISO → `3/12 10:20`（本地时区；与产品其它地方的相对时间口径一致，不用 UTC） */
function formatLocalMinute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
