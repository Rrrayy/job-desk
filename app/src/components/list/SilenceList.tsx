/**
 * 模块四 · 沉默待办清单（SIL-1 ~ SIL-8）。
 *
 * 落位：列表页的第二个页签（「全部投递」旁边）。**不改导航**。
 *
 * 三条读图规则见 `lib/silence/list.ts` 头注释，这里一个字都不改地照做：
 * 1. 分组只看 `silence.level`（内推阈值 ×3，所以「内推 10 天」是黄不是红）；
 * 2. 红组里 15 天处只画一条分割线，不建子组 —— 只有一套计数口径，用户才对得上账；
 * 3. 静音条目留在原组（灰显 + ⌛），否则「7 条」这个数字会随静音状态变化。
 */

import { Fragment, useMemo, useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { SilenceRow } from '../../lib/silence/list';
import {
  SILENCE_RENDER_LIMIT,
  STALE_SPLIT_DAYS,
  buildSilenceGroups,
  muteLabelOf,
  silenceListToMarkdown,
  silenceRowsOf,
} from '../../lib/silence/list';
import { CHANNEL_LABEL } from '../../lib/rules';
import { loadSilencePrefs, saveSilencePrefs, type SilencePrefs } from '../../lib/storage';
import { companyLabel, copyText, cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';
import { BatchBar } from './BatchBar';

export interface SilenceListProps {
  api: AppApi;
}

export function SilenceList({ api }: SilenceListProps) {
  /** 「隐藏静音」是独立偏好（`jobdesk.v1.silencePrefs`），不塞进 ListFilterState */
  const [prefs, setPrefs] = useState<SilencePrefs>(() => loadSilencePrefs());
  const [checkedIds, setCheckedIds] = useState<string[]>([]);

  const rows = useMemo(() => silenceRowsOf(api.db, api.now), [api.db, api.now]);
  const groups = useMemo(
    () => buildSilenceGroups(rows, { hideMuted: prefs.hideMuted }),
    [rows, prefs.hideMuted],
  );

  /**
   * D-11：不做虚拟滚动，超过上限就截断并**明说**截断了多少 ——
   * 「我明明有 260 条，界面只显示 200」是比卡顿更坏的体验。
   */
  const staleShown = groups.stale.slice(0, SILENCE_RENDER_LIMIT);
  const warnShown = groups.warn.slice(0, Math.max(0, SILENCE_RENDER_LIMIT - staleShown.length));
  const hiddenCount = groups.total - staleShown.length - warnShown.length;

  const shownRows = [...staleShown, ...warnShown];
  const shownIds = shownRows.map((row) => row.app.id);
  const pickedRows = shownRows.filter((row) => checkedIds.includes(row.app.id));

  const toggle = (id: string): void => {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const allPicked = shownIds.length > 0 && pickedRows.length === shownIds.length;
  const toggleAll = (): void => setCheckedIds(allPicked ? [] : shownIds);

  const applyHideMuted = (hideMuted: boolean): void => {
    const next: SilencePrefs = { ...prefs, hideMuted };
    setPrefs(next);
    saveSilencePrefs(next);
    // 隐藏之后这些行不在了，勾选里也不该留着它们的 id
    if (hideMuted) {
      const mutedIds = new Set(rows.filter((row) => row.muted).map((row) => row.app.id));
      setCheckedIds((prev) => prev.filter((id) => !mutedIds.has(id)));
    }
  };

  const exportList = async (): Promise<void> => {
    const ok = await copyText(silenceListToMarkdown(pickedRows.length > 0 ? pickedRows : shownRows));
    api.toast(ok ? '已复制 Markdown 清单' : '复制失败，请手动选中文本');
  };

  const renderRow = (row: SilenceRow) => {
    const label = `${companyLabel(api.db.companies, row.app.companyId)} · ${row.app.jobTitle}`;
    const checked = checkedIds.includes(row.app.id);
    const meta = [row.app.city, row.app.channel ? CHANNEL_LABEL[row.app.channel] : '']
      .filter(Boolean)
      .join(' · ');
    return (
      <li
        key={row.app.id}
        className={cx(
          'sil__row',
          row.silence.level === 'stale' ? 'sil__row--stale' : 'sil__row--warn',
          row.muted && 'is-muted',
          checked && 'is-checked',
        )}
        data-testid={`sil-row-${row.app.id}`}
      >
        <input
          type="checkbox"
          className="sil__check"
          checked={checked}
          aria-label={`选择 ${label}`}
          onChange={() => toggle(row.app.id)}
        />
        <button type="button" className="sil__main" onClick={() => api.openDetail(row.app.id)}>
          <span className="sil__names">
            <span className="sil__company">{companyLabel(api.db.companies, row.app.companyId)}</span>
            <span className="sil__job">{row.app.jobTitle}</span>
          </span>
          <span className="sil__meta">{meta || '还没填城市 / 渠道'}</span>
        </button>
        <span className={cx('badge', row.silence.level === 'stale' ? 'badge--stale' : 'badge--warn')}>
          {row.silence.text}
        </span>
        {row.muted ? (
          <span className="sil__mute" title="静音只是不在清单里催你，记录一个字都不动">
            ⌛ {muteLabelOf(row.app.mutedUntil)}
          </span>
        ) : null}
        <button type="button" className={CLS.h} onClick={() => api.openDetail(row.app.id)}>
          {row.suggestion.label}
        </button>
      </li>
    );
  };

  if (rows.length === 0) {
    return (
      <div className={CLS.C}>
        <div className={CLS.y}>🌿</div>
        <h3 className={CLS.z}>最近没有谁被冷落</h3>
        <p className={CLS.A}>
          清单按「最后一条记录」算沉默天数，跟状态改到哪天无关。静下来超过阈值才会出现在这里。
        </p>
      </div>
    );
  }

  return (
    <div className="sil" data-testid="silence-list">
      <div className="sil__head">
        <span className="sil__stat">
          <strong>{groups.total}</strong> 条该看一眼
          {groups.mutedTotal > 0 ? ` · ${groups.mutedTotal} 条已静音` : ''}
        </span>
        <div className={CLS.r}>
          <button type="button" className={CLS.b} onClick={toggleAll}>
            {allPicked ? '全不选' : '全选'}
          </button>
          <button type="button" className={CLS.b} onClick={() => void exportList()}>
            {pickedRows.length > 0 ? `导出已选 ${pickedRows.length} 条` : '导出清单'}
          </button>
        </div>
      </div>

      <div className="sil__controls">
        <label className="sil__toggle">
          <input
            type="checkbox"
            checked={prefs.hideMuted}
            data-testid="sil-hide-muted"
            onChange={(event) => applyHideMuted(event.target.checked)}
          />
          <span>隐藏已静音的 {groups.mutedTotal} 条</span>
        </label>
        <span className={CLS.c}>
          静音原样留在组里才数得清账 —— 勾上这个才藏起来，藏起来也还是那些条。
        </span>
      </div>

      {pickedRows.length > 0 ? (
        <BatchBar api={api} rows={pickedRows} onClear={() => setCheckedIds([])} />
      ) : null}

      {groups.stale.length > 0 ? (
        <section className="sil__group">
          <h3 className="sil__group-head">
            <span className="sil__group-count sil__group-count--stale">{groups.stale.length}</span>
            已沉默
            <span className={CLS.c}>超过阈值没动静了，该主动问一句</span>
          </h3>
          <ul className="sil__rows">
            {staleShown.map((row, index) => (
              <Fragment key={row.app.id}>
                {index === groups.staleSplitAt ? (
                  <li className="sil__split" aria-hidden="true">
                    ↓ {STALE_SPLIT_DAYS} 天以内
                  </li>
                ) : null}
                {renderRow(row)}
              </Fragment>
            ))}
          </ul>
        </section>
      ) : null}

      {groups.warn.length > 0 ? (
        <section className="sil__group">
          <h3 className="sil__group-head">
            <span className="sil__group-count sil__group-count--warn">{groups.warn.length}</span>
            该跟进
            <span className={CLS.c}>刚过提醒线，趁还热乎</span>
          </h3>
          <ul className="sil__rows">{warnShown.map((row) => renderRow(row))}</ul>
        </section>
      ) : null}

      {hiddenCount > 0 ? (
        <p className={CLS.c}>
          还有 {hiddenCount} 条没显示（一次最多渲染 {SILENCE_RENDER_LIMIT} 条）。先处理上面这些，
          处理完它们会自己浮上来。
        </p>
      ) : null}

      <p className={CLS.c}>
        沉默天数按「最后一条记录」算，不是按状态改到哪天 —— 记一条面试复盘就会重新开始计时。
      </p>
    </div>
  );
}
