/**
 * 模块二 · 公司档案抽屉（COM-1 ~ COM-3）。
 *
 * 用户点开公司档案的第一诉求是「这家还有没有戏」，所以结构顺序是
 * 概览 → 小计 → 投递 → 面试 → 面经 → 时间轴：**时间轴在最下面**（不是流水账优先）。
 *
 * 三条硬口径：
 * - 已删除的投递及其子记录一律不计入（由 `companyDossierOf` 保证，这里不再判）；
 * - 概览的空字段不产生行（COM-2），所以这一块不写「规模：—」这种占位；
 * - 面经的 N 与题库筛出来的 N 必须是同一个 N（COM-3）—— 跳转时把原始 companyName 一起带过去。
 */

import type { AppApi } from '../../lib/api';
import { companyDossierOf } from '../../lib/company/dossier';
import { companyOverviewRows } from '../../lib/company/fields';
import { fmtDate, fmtDateTime } from '../../lib/date';
import { cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';
import { CompanyFields } from './CompanyFields';

export function CompanyDossier({ api }: { api: AppApi }) {
  const companyId = api.company.dossierId;
  if (!companyId) return null;
  const dossier = companyDossierOf(api.db, companyId, api.now);
  if (!dossier) return null;

  const { company, stats } = dossier;
  const overview = companyOverviewRows(company);

  return (
    <div className={CLS.H} onClick={api.company.closeDossier}>
      <aside className="drawer drawer--dossier" onClick={(event) => event.stopPropagation()}>
        <header className={CLS.K}>
          <div className={CLS.ah}>
            <h2 className={CLS.I} data-testid="dossier-title">
              {company.name}
              {company.shortName && company.shortName !== company.name ? (
                <span className={CLS.d}>（{company.shortName}）</span>
              ) : null}
            </h2>
            <p className="dossier__sub">
              {stats.applications} 次投递 · 面过 {stats.interviewed} 家 ·{' '}
              {stats.offer > 0 ? `${stats.offer} 个 Offer` : '还没 Offer'}
            </p>
          </div>
          <button
            type="button"
            className={CLS.m}
            onClick={api.company.closeDossier}
            title="关闭（Esc）"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <div className={CLS.J}>
          {/* ---------------- 概览 ---------------- */}
          <section className={CLS.n}>
            <h3 className={CLS.i}>这家公司</h3>
            {overview.length > 0 ? (
              <dl className="dossier__overview" data-testid="dossier-overview">
                {overview.map((row) => (
                  <div key={row.label} className="dossier__overview-row">
                    <dt>{row.label}</dt>
                    <dd>
                      {row.href ? (
                        <a href={row.href} target="_blank" rel="noreferrer noopener">
                          {row.value}
                        </a>
                      ) : (
                        row.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className={CLS.d}>还没填任何公司信息 —— 填一次，以后每条投递都能看到。</p>
            )}
            <CompanyFields api={api} company={company} />
          </section>

          {/* ---------------- 小计（COM-5） ---------------- */}
          <section className={CLS.n}>
            <h3 className={CLS.i}>小计</h3>
            <div className="dossier__stats" data-testid="dossier-stats">
              <div className={CLS.aQ}>
                <span className={CLS.aP}>{stats.applications}</span>
                <span className={CLS.aO}>投递</span>
              </div>
              <div className={CLS.aQ}>
                <span className={CLS.aP}>{stats.interviewed}</span>
                <span className={CLS.aO}>面过</span>
              </div>
              <div className={CLS.aQ}>
                <span className={CLS.aP}>{stats.rejected}</span>
                <span className={CLS.aO}>已挂</span>
              </div>
              <div className={CLS.aQ}>
                <span className={CLS.aP}>{stats.offer}</span>
                <span className={CLS.aO}>Offer</span>
              </div>
              <div className={CLS.aQ}>
                <span className={CLS.aP}>{stats.avgSilenceDays}</span>
                <span className={CLS.aO}>平均沉默天数</span>
              </div>
            </div>
          </section>

          {/* ---------------- 投递 ---------------- */}
          <section className={CLS.n}>
            <h3 className={CLS.i}>投递（{dossier.applications.length}）</h3>
            {dossier.applications.length === 0 ? (
              <p className={CLS.d}>这家公司还没有投递记录。</p>
            ) : (
              <ul className="dossier__apps">
                {dossier.applications.map((row) => (
                  <li key={row.app.id}>
                    <button
                      type="button"
                      className={CLS.k}
                      onClick={() => {
                        api.openDetail(row.app.id);
                      }}
                    >
                      {row.app.jobTitle}
                    </button>
                    <span className={CLS.d}>
                      {fmtDate(row.app.appliedAt)} · {row.silence.level ? row.silence.text : '最近有互动'}
                      {row.hasOffer ? ' · 有 Offer 信息' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ---------------- 面试 ---------------- */}
          {dossier.interviews.length > 0 ? (
            <section className={CLS.n}>
              <h3 className={CLS.i}>面试（{dossier.interviews.length}）</h3>
              <ul className="dossier__interviews">
                {dossier.interviews.map((row) => (
                  <li key={row.interview.id}>
                    <span className="dossier__interview-when">{fmtDateTime(row.interview.scheduledAt)}</span>
                    <span className={CLS.d}>
                      第 {row.interview.round} 轮 · {row.jobTitle}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* ---------------- 面经题库（COM-3） ---------------- */}
          <section className={CLS.n}>
            <h3 className={CLS.i}>这家的面经</h3>
            {dossier.experience.total === 0 ? (
              <p className={CLS.d}>还没有这家的面经题。收到面试后记一次，下次就有底了。</p>
            ) : (
              <div className={cx(CLS.r, 'dossier__exp')}>
                <span>
                  共 {dossier.experience.total} 题，{dossier.experience.unmastered} 题还没掌握
                </span>
                <button
                  type="button"
                  className={CLS.b}
                  onClick={() => api.company.openQuestionBank(dossier.experienceNames)}
                >
                  去题库复习这批题
                </button>
              </div>
            )}
          </section>

          {/* ---------------- 时间轴（COM-1） ---------------- */}
          <section className={CLS.n}>
            <h3 className={CLS.i}>时间轴（{dossier.timeline.length}）</h3>
            {dossier.timeline.length === 0 ? (
              <p className={CLS.d}>还没有任何记录。</p>
            ) : (
              <ol className="dossier__timeline" data-testid="dossier-timeline">
                {dossier.timeline.map((entry) => (
                  <li key={entry.id} className={cx('dossier__tl-item', entry.who === 'system' && 'is-system')}>
                    <span className="dossier__tl-at">{fmtDateTime(entry.at)}</span>
                    <span className="dossier__tl-text">{entry.text}</span>
                    <span className="dossier__tl-job">{entry.jobLabel}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
