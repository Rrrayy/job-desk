/** 顶部导航：Logo + 5 个视图 + 全局搜索 + 设置 + 「＋ 记一家」。 */

import { useState } from 'react';
import { VIEWS, type ViewKey } from '../lib/api';
import { STATUS_LABEL } from '../lib/rules';
import type { Status } from '../types';
import { cx } from '../lib/util';

export interface SearchHit {
  id: string;
  company: string;
  jobTitle: string;
  status: Status;
}

export interface TopBarProps {
  view: ViewKey;
  onView: (view: ViewKey) => void;
  query: string;
  onQuery: (value: string) => void;
  hits: SearchHit[];
  onPick: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
  /** v0.2：⇅ 同步入口（有暂存/冲突时带红点与条数） */
  onSync: () => void;
  pendingSync: number;
  searchRef: React.RefObject<HTMLInputElement>;
}

export function TopBar(props: TopBarProps) {
  const { view, onView, query, onQuery, hits, onPick, onNew, onSettings, onSync, pendingSync, searchRef } =
    props;
  const [focused, setFocused] = useState(false);
  const showResults = focused && query.trim().length > 0;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && hits.length > 0) {
      event.preventDefault();
      onPick(hits[0].id);
      onQuery('');
      event.currentTarget.blur();
    }
    if (event.key === 'Escape') {
      onQuery('');
      event.currentTarget.blur();
    }
  };

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__mark">职</span>
        <span className="topbar__name">求职工作台</span>
      </div>

      <nav className="nav">
        {VIEWS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={cx('nav__item', view === item.key && 'is-active')}
            onClick={() => onView(item.key)}
            title={`${item.label}（快捷键 ${item.hint}）`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="topbar__right">
        <div className={cx('search', showResults && 'is-open')}>
          <span className="search__icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={searchRef}
            className="search__input"
            value={query}
            placeholder="搜公司 / 岗位"
            onChange={(event) => onQuery(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 120)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="search__kbd">⌘K</kbd>
          {showResults ? (
            <div className="search__results">
              {hits.length === 0 ? (
                <div className="search__empty">没有匹配的公司或岗位</div>
              ) : (
                hits.slice(0, 6).map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    className="search__result"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onPick(hit.id);
                      onQuery('');
                    }}
                  >
                    <span className="search__result-main">
                      {hit.company} · {hit.jobTitle}
                    </span>
                    <span className="search__result-status">{STATUS_LABEL[hit.status]}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="btn btn--small topbar__sync"
          onClick={onSync}
          title={pendingSync > 0 ? `${pendingSync} 条待确认（暂存区）` : '同步平台进度（粘贴页面文本，本地解析）'}
        >
          <span className="topbar__sync-icon" aria-hidden="true">
            ⇅
          </span>
          同步
          {pendingSync > 0 ? <span className="topbar__sync-dot">{pendingSync}</span> : null}
        </button>
        <button type="button" className="icon-btn" onClick={onSettings} title="设置">
          ⚙
        </button>
        <button type="button" className="btn btn--primary" onClick={onNew}>
          ＋ 记一家
        </button>
      </div>
    </header>
  );
}
