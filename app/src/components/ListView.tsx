/**
 * 列表视图：表格化、可排序、可筛选，重点突出沉默天数。
 * stale 行整行浅红底，一眼就能看出「哪家最久没动静」。
 */

import { useEffect, useMemo, useState } from 'react';
import type { AppApi } from '../lib/api';
import type { Channel, Status } from '../types';
import {
  ALL_STATUSES,
  CHANNEL_LABEL,
  CHANNEL_OPTIONS,
  STATUS_LABEL,
  buildNoteIndex,
  effectiveStaleDays,
  nextInterviewOf,
  rejectedRoundShort,
  silenceStateOf,
} from '../lib/rules';
import { fmtDate, fmtDateTime, timeValue } from '../lib/date';
import { companyLabel, cx } from '../lib/util';
import { useVirtualList } from '../lib/virtual';
import { DEFAULT_LIST_FILTERS, loadListFilters, saveListFilters, type ListFilterState } from '../lib/storage';

/**
 * 列表行高（px）。固定值 —— 虚拟滚动靠它算区间，改 CSS 必须同步改这里。
 * 38 = 上下 padding 9×2 + 行内文字 20（12px 字号 × 1.66 行高）
 */
const ROW_HEIGHT = 38;

type SortKey =
  | 'company'
  | 'jobTitle'
  | 'city'
  | 'channel'
  | 'version'
  | 'appliedAt'
  | 'silence'
  | 'nextAction'
  | 'status';

const SORT_LABEL: Record<SortKey, string> = {
  company: '公司',
  jobTitle: '岗位',
  city: '城市',
  channel: '渠道',
  version: '简历版本',
  appliedAt: '投递日',
  silence: '沉默天数',
  nextAction: '下一次动作',
  status: '状态',
};

export function ListView({ api }: { api: AppApi }) {
  const { db, now } = api;
  /**
   * 筛选条件跨刷新保留（QA D7）：状态/渠道/简历版本/城市/关键词/排序一起存。
   * 首次渲染读一次缓存，之后每次变化写回；读到的脏值一律回默认值，
   * 免得一条坏缓存把列表筛成空的。
   */
  const [seed] = useState<ListFilterState>(() => loadListFilters() ?? DEFAULT_LIST_FILTERS);
  const [statusFilter, setStatusFilter] = useState<'all' | Status>(() =>
    seed.status === 'all' || (ALL_STATUSES as readonly string[]).includes(seed.status)
      ? (seed.status as 'all' | Status)
      : 'all',
  );
  const [channelFilter, setChannelFilter] = useState<'all' | Channel>(() =>
    seed.channel === 'all' || (CHANNEL_OPTIONS as readonly string[]).includes(seed.channel)
      ? (seed.channel as 'all' | Channel)
      : 'all',
  );
  const [versionFilter, setVersionFilter] = useState<'all' | string>(() => seed.version || 'all');
  /** 城市多选：从现有数据里动态去重，'' 代表「未填城市」 */
  const [cityFilter, setCityFilter] = useState<string[]>(() => seed.cities);
  const [cityOpen, setCityOpen] = useState(false);
  const [keyword, setKeyword] = useState<string>(() => seed.keyword);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>(() =>
    Object.prototype.hasOwnProperty.call(SORT_LABEL, seed.sortKey)
      ? { key: seed.sortKey as SortKey, dir: seed.sortDir }
      : { key: 'silence', dir: 'desc' },
  );

  useEffect(() => {
    saveListFilters({
      status: statusFilter,
      channel: channelFilter,
      version: versionFilter,
      cities: cityFilter,
      keyword,
      sortKey: sort.key,
      sortDir: sort.dir,
    });
  }, [statusFilter, channelFilter, versionFilter, cityFilter, keyword, sort]);

  const versions = useMemo(() => {
    const set = new Set<string>();
    for (const app of db.applications) {
      if (app.resumeVersion) set.add(app.resumeVersion);
    }
    return [...set].sort();
  }, [db.applications]);

  /** 城市选项：不硬编码，全从现有投递里动态去重 */
  const cities = useMemo(() => {
    const counter = new Map<string, number>();
    for (const app of db.applications) {
      const key = (app.city || '').trim();
      counter.set(key, (counter.get(key) || 0) + 1);
    }
    return [...counter.entries()]
      .sort((a, b) => {
        if (a[0] === '') return 1;
        if (b[0] === '') return -1;
        return a[0].localeCompare(b[0], 'zh-Hans-CN');
      })
      .map(([value, count]) => ({ value, label: value || '未填城市', count }));
  }, [db.applications]);

  const toggleCity = (value: string): void => {
    setCityFilter((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value],
    );
  };

  const rows = useMemo(() => {
    const keywordText = keyword.trim().toLowerCase();
    // 索引只建一次：否则每行都要扫一遍全库时间线（O(投递数 × 时间线条数)）
    const noteIndex = buildNoteIndex(db.notes);
    const list = db.applications
      .map((app) => {
        const silence = silenceStateOf(app, db.notes, db.settings, now, noteIndex);
        const next = nextInterviewOf(db.interviews, app.id, now);
        return {
          app,
          silence,
          next,
          company: companyLabel(db.companies, app.companyId),
          noteCount: noteIndex.get(app.id)?.length ?? 0,
        };
      })
      .filter((row) => {
        if (statusFilter !== 'all' && row.app.status !== statusFilter) return false;
        if (channelFilter !== 'all' && (row.app.channel || 'other') !== channelFilter) return false;
        if (versionFilter !== 'all' && (row.app.resumeVersion || '') !== versionFilter) return false;
        if (cityFilter.length > 0 && !cityFilter.includes((row.app.city || '').trim())) return false;
        if (keywordText) {
          const haystack = `${row.company} ${row.app.jobTitle} ${row.app.city || ''}`.toLowerCase();
          if (!haystack.includes(keywordText)) return false;
        }
        return true;
      });

    const dir = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sort.key) {
        case 'company':
          return a.company.localeCompare(b.company, 'zh-Hans-CN') * dir;
        case 'jobTitle':
          return a.app.jobTitle.localeCompare(b.app.jobTitle, 'zh-Hans-CN') * dir;
        case 'city':
          return (a.app.city || '').localeCompare(b.app.city || '', 'zh-Hans-CN') * dir;
        case 'channel':
          return (a.app.channel || '').localeCompare(b.app.channel || '') * dir;
        case 'version':
          return (a.app.resumeVersion || '').localeCompare(b.app.resumeVersion || '', 'zh-Hans-CN') * dir;
        case 'appliedAt':
          return (timeValue(a.app.appliedAt) - timeValue(b.app.appliedAt)) * dir;
        case 'silence':
          return (a.silence.days - b.silence.days) * dir;
        case 'nextAction': {
          const av = timeValue(a.app.nextActionAt || a.next?.scheduledAt || null);
          const bv = timeValue(b.app.nextActionAt || b.next?.scheduledAt || null);
          return (av - bv) * dir;
        }
        case 'status':
          return (ALL_STATUSES.indexOf(a.app.status) - ALL_STATUSES.indexOf(b.app.status)) * dir;
        default:
          return 0;
      }
    });
    return list;
  }, [db, now, statusFilter, channelFilter, versionFilter, cityFilter, keyword, sort]);

  /**
   * 窗口化（v0.5 / D6）：行高固定 38px（见 styles.css .table td 的 padding
   * + line-height），所以能用纯算术算渲染区间。行高一旦改，这里必须同步改。
   */
  const virtual = useVirtualList({ rowHeight: ROW_HEIGHT, count: rows.length });

  const toggleSort = (key: SortKey): void => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' },
    );
  };

  const clearFilters = (): void => {
    setStatusFilter('all');
    setChannelFilter('all');
    setVersionFilter('all');
    setCityFilter([]);
    setKeyword('');
  };

  const arrow = (key: SortKey): string => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '');

  if (db.applications.length === 0) {
    return (
      <div className="page">
        <div className="empty-block">
          <div className="empty-block__emoji">📋</div>
          <h2 className="empty-block__title">还没有任何投递记录。</h2>
          <p className="empty-block__text">列表会把所有公司摊平给你看，但得先有一家。</p>
          <button type="button" className="btn btn--primary btn--lg" onClick={() => api.openNew()}>
            ＋ 记第一家
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="board-head">
        <h2 className="page__title">列表</h2>
        <span className="page__sub">
          共 {db.applications.length} 条，当前筛选出 {rows.length} 条
        </span>
      </div>

      <div className="filters">
        <div className="filters__group">
          <select
            className="select select--compact"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as 'all' | Status)}
          >
            <option value="all">全部状态</option>
            {ALL_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
          <select
            className="select select--compact"
            value={channelFilter}
            onChange={(event) => setChannelFilter(event.target.value as 'all' | Channel)}
          >
            <option value="all">全部渠道</option>
            {CHANNEL_OPTIONS.map((channel) => (
              <option key={channel} value={channel}>
                {CHANNEL_LABEL[channel]}
              </option>
            ))}
          </select>
          <select
            className="select select--compact"
            value={versionFilter}
            onChange={(event) => setVersionFilter(event.target.value)}
          >
            <option value="all">全部简历版本</option>
            {versions.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>

          <div className="multiselect">
            <button
              type="button"
              className={cx('select select--compact', 'multiselect__trigger', cityFilter.length > 0 && 'is-active')}
              onClick={() => setCityOpen(!cityOpen)}
              title="按城市筛选（可多选）"
            >
              {cityFilter.length === 0
                ? '全部城市'
                : cityFilter.length === 1
                  ? cityFilter[0] || '未填城市'
                  : `已选 ${cityFilter.length} 个城市`}
              <span className="multiselect__caret">▾</span>
            </button>
            {cityOpen ? (
              <>
                <div className="ms-backdrop" onClick={() => setCityOpen(false)} />
                <div className="multiselect__panel">
                  {cities.length === 0 ? (
                    <p className="muted">还没有填过城市</p>
                  ) : (
                    cities.map((city) => (
                      <label key={city.value || '__empty'} className="ms-option">
                        <input
                          type="checkbox"
                          checked={cityFilter.includes(city.value)}
                          onChange={() => toggleCity(city.value)}
                        />
                        <span className="ms-option__label">{city.label}</span>
                        <span className="ms-option__count">{city.count}</span>
                      </label>
                    ))
                  )}
                  <div className="multiselect__foot">
                    <button type="button" className="link-btn" onClick={() => setCityFilter([])}>
                      清除城市
                    </button>
                    <button type="button" className="link-btn" onClick={() => setCityOpen(false)}>
                      收起
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <input
            className="input input--compact"
            placeholder="搜公司 / 岗位 / 城市"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>
        <button type="button" className="btn btn--small" onClick={clearFilters}>
          清除筛选
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="quiet quiet--boxed">
          <p className="quiet__title">这个筛选下没有公司。</p>
          <p className="quiet__text">换个条件，或者把筛选清掉。</p>
          <button type="button" className="btn btn--small" onClick={clearFilters}>
            清除筛选
          </button>
        </div>
      ) : (
        <div className="table-wrap" ref={virtual.containerRef} onScroll={virtual.onScroll}>
          <table className="table">
            <thead>
              <tr>
                {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
                  <th key={key} onClick={() => toggleSort(key)} title="点击排序">
                    {SORT_LABEL[key]}
                    {arrow(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* v0.5 / D6：超过阈值时只渲染视口内的行，用两个占位行撑出滚动高度。
                  占位用 <tr> 而不是 div —— <table> 里塞别的元素会被浏览器挪出表格外。 */}
              {virtual.range.padTop > 0 ? (
                <tr aria-hidden="true" className="table__spacer">
                  <td colSpan={9} style={{ height: virtual.range.padTop, padding: 0, border: 0 }} />
                </tr>
              ) : null}
              {rows.slice(virtual.range.start, virtual.range.end).map((row) => {
                const stale = row.silence.level === 'stale';
                const staleAt = effectiveStaleDays(row.app, db.settings);
                return (
                  <tr
                    key={row.app.id}
                    className={cx(stale && 'is-stale')}
                    onClick={() => api.openDetail(row.app.id)}
                  >
                    <td>
                      <span className="table__company">{row.company}</span>
                    </td>
                    <td>{row.app.jobTitle}</td>
                    <td>{row.app.city || '—'}</td>
                    <td>{row.app.channel ? CHANNEL_LABEL[row.app.channel] : '—'}</td>
                    <td className="table__version">{row.app.resumeVersion || '—'}</td>
                    <td>{fmtDate(row.app.appliedAt)}</td>
                    <td>
                      {row.silence.level ? (
                        <span className={cx('cell-silence', `cell-silence--${row.silence.level}`)}>
                          {row.silence.days} 天
                          <span className="cell-silence__hint">/ {staleAt} 天</span>
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {row.app.nextActionAt ? (
                        fmtDate(row.app.nextActionAt)
                      ) : row.next ? (
                        <span className="muted">{fmtDateTime(row.next.scheduledAt)} 面试</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className="table__status">{STATUS_LABEL[row.app.status]}</span>
                      {row.app.status === 'rejected' ? (
                        row.app.rejectedAtRound === null || row.app.rejectedAtRound === undefined ? (
                          <button
                            type="button"
                            className="link-btn table__round"
                            title="去详情里补录挂在哪一轮"
                            onClick={(event) => {
                              event.stopPropagation();
                              api.openDetail(row.app.id);
                            }}
                          >
                            轮次未记
                          </button>
                        ) : (
                          <span className="table__round-done">{rejectedRoundShort(row.app.rejectedAtRound)}</span>
                        )
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {virtual.range.padBottom > 0 ? (
                <tr aria-hidden="true" className="table__spacer">
                  <td colSpan={9} style={{ height: virtual.range.padBottom, padding: 0, border: 0 }} />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
