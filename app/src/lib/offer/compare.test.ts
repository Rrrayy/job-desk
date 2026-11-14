/**
 * 模块一 · 对比候选集、对比表行与提醒（PRD §3.1 OFF-6 / OFF-9）。
 *
 * 两个容易做错的地方，都在这里钉住：
 * 1. 候选集只看状态，不看「有没有填薪资」—— 刚拿到口头 offer 时最需要并排看；
 * 2. 综合分下面必须摊开每一维的贡献，缺维写「未评（不计入）」而不是 0。
 */

import { describe, expect, it } from 'vitest';
import type { Application, Company, DB, OfferDetail } from '../../types';
import { emptyDB } from '../defaults';
import {
  MAX_COMPARE,
  buildCompareRows,
  buildOfferAlerts,
  defaultSelection,
  offerCandidatesOf,
  toggleSelection,
} from './compare';
import { DEFAULT_OFFER_WEIGHTS } from './score';

/** 固定「今天」：所有断言都基于本地时区的自然日，换成 UTC 会让期望值变成玄学 */
const NOW = new Date(2026, 10, 1, 9, 0, 0);
const NOW_ISO = NOW.toISOString();

function makeCompany(id: string, name: string, shortName?: string): Company {
  return shortName
    ? { id, name, shortName, createdAt: '2026-09-01T00:00:00.000Z' }
    : { id, name, createdAt: '2026-09-01T00:00:00.000Z' };
}

function makeApp(
  id: string,
  companyId: string,
  overrides: Partial<Application> = {},
): Application {
  return {
    id,
    companyId,
    jobTitle: `岗位 ${id}`,
    status: 'offer',
    statusChangedAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function makeOffer(overrides: Partial<OfferDetail> = {}): OfferDetail {
  return { updatedAt: NOW_ISO, ...overrides };
}

function makeDB(companies: Company[], applications: Application[]): DB {
  const db = emptyDB();
  db.companies = companies;
  db.applications = applications;
  return db;
}

describe('offerCandidatesOf · 候选集只看状态', () => {
  it('只收 offer / onboarded，未删除；其余状态一律不进来', () => {
    const db = makeDB(
      [makeCompany('c1', '字节跳动', '字节')],
      [
        makeApp('a1', 'c1', { status: 'offer' }),
        makeApp('a2', 'c1', { status: 'onboarded' }),
        makeApp('a3', 'c1', { status: 'interviewing' }),
        makeApp('a4', 'c1', { status: 'offer', deletedAt: '2026-10-30T00:00:00.000Z' }),
      ],
    );
    const candidates = offerCandidatesOf(db, NOW);
    expect(candidates.map((item) => item.app.id)).toEqual(['a1', 'a2']);
  });

  it('★ 没填任何薪资的 offer 也在候选集里（口头 offer 阶段最需要并排看）', () => {
    const db = makeDB([makeCompany('c1', '美团')], [makeApp('a1', 'c1', { status: 'offer' })]);
    const [candidate] = offerCandidatesOf(db, NOW);
    expect(candidate.offer).toBeUndefined();
    expect(candidate.score.total).toBeNull();
  });

  it('已入职的排在最后（回看场景先看还在等答复的）', () => {
    const db = makeDB(
      [makeCompany('c1', 'A')],
      [
        makeApp('a-onboarded', 'c1', { status: 'onboarded' }),
        makeApp('a-offer', 'c1', { status: 'offer' }),
      ],
    );
    expect(offerCandidatesOf(db, NOW).map((item) => item.app.id)).toEqual(['a-offer', 'a-onboarded']);
  });

  it('公司缺失时不崩：company 为 undefined', () => {
    const db = makeDB([], [makeApp('a1', 'c-missing', { status: 'offer' })]);
    expect(offerCandidatesOf(db, NOW)[0].company).toBeUndefined();
  });
});

describe('defaultSelection / toggleSelection · 最多 8 个', () => {
  function candidates(count: number): ReturnType<typeof offerCandidatesOf> {
    const apps: Application[] = [];
    for (let i = 0; i < count; i += 1) {
      apps.push(
        makeApp(`a${i}`, 'c1', {
          status: 'offer',
          offer: makeOffer({ monthlySalary: 10000 + i, updatedAt: `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00.000Z` }),
        }),
      );
    }
    return offerCandidatesOf(makeDB([makeCompany('c1', 'A')], apps), NOW);
  }

  it('不超过 8 个 → 全选，overflow = 0', () => {
    const result = defaultSelection(candidates(3));
    expect(result.ids).toEqual(['a0', 'a1', 'a2']);
    expect(result.overflow).toBe(0);
  });

  it('超过 8 个 → 按 offer.updatedAt 取最近 8 个，并报出被拒条数', () => {
    const result = defaultSelection(candidates(10));
    expect(result.ids).toHaveLength(MAX_COMPARE);
    expect(result.overflow).toBe(2);
    // 最新的那 8 个：a2..a9
    expect(result.ids).toEqual(['a9', 'a8', 'a7', 'a6', 'a5', 'a4', 'a3', 'a2']);
  });

  it('没填 offer 的排在最后（updatedAt 视为空串）', () => {
    const list = candidates(9);
    list.push(...offerCandidatesOf(makeDB([makeCompany('c9', 'B')], [makeApp('a-empty', 'c9', { status: 'offer' })]), NOW));
    const result = defaultSelection(list);
    expect(result.ids).not.toContain('a-empty');
    expect(result.overflow).toBe(2);
  });

  it('toggleSelection：未选的加入、已选的移除', () => {
    expect(toggleSelection(['a1'], 'a2')).toEqual({ ids: ['a1', 'a2'], rejected: false });
    expect(toggleSelection(['a1', 'a2'], 'a1')).toEqual({ ids: ['a2'], rejected: false });
  });

  it('★ 勾第 9 个被拒：返回原数组（顺序不变）+ rejected 标记，供 UI 弹一句提示', () => {
    const full = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
    expect(toggleSelection(full, 'a9')).toEqual({ ids: full, rejected: true });
  });
});

describe('buildCompareRows · 摊开每一维的贡献', () => {
  function twoOffers(): ReturnType<typeof offerCandidatesOf> {
    const db = makeDB(
      [makeCompany('c1', '字节跳动', '字节'), makeCompany('c2', '美团')],
      [
        makeApp('a1', 'c1', {
          status: 'offer',
          city: '北京',
          deadlineAt: '2026-11-03',
          offer: makeOffer({
            payMode: 'monthly',
            monthlySalary: 20000,
            salaryMonths: 15,
            signOnBonus: 10000,
            equityText: '5000 股',
            level: 'P5',
            commuteMin: 35,
            scores: { salary: 5, growth: 4, city: 3, wlb: 2 },
          }),
        }),
        makeApp('a2', 'c2', { status: 'offer', offer: makeOffer({ payMode: 'daily', dailyRate: 400 }) }),
      ],
    );
    return offerCandidatesOf(db, NOW);
  }

  it('行顺序固定：综合分 → 四维 → 薪资结构 → 签字费 → 年薪 → 股权 → 城市/职级 → 通勤 → 截止 → 已评维度', () => {
    const rows = buildCompareRows(twoOffers(), DEFAULT_OFFER_WEIGHTS);
    expect(rows.map((row) => row.key)).toEqual([
      'total',
      'dim-salary',
      'dim-growth',
      'dim-city',
      'dim-wlb',
      'salary',
      'signOn',
      'annual',
      'equity',
      'cityLevel',
      'commute',
      'deadline',
      'rated',
    ]);
  });

  it('综合分保留 1 位小数；未评写「—」而不是 0', () => {
    const rows = buildCompareRows(twoOffers(), DEFAULT_OFFER_WEIGHTS);
    const total = rows[0];
    // 5/4/3/2 @ 30/30/20/20 → 370×200/100/10 = 74.0
    expect(total.cells[0].text).toBe('74.0');
    expect(total.cells[1].text).toBe('—');
    expect(total.cells[1].tone).toBe('muted');
  });

  it('★ 少评几维时格内必须标出「按 N/4 维归一」（否则会被当成 bug 报）', () => {
    const list = offerCandidatesOf(
      makeDB(
        [makeCompany('c1', 'A')],
        [makeApp('a1', 'c1', { status: 'offer', offer: makeOffer({ scores: { salary: 5, growth: 5 } }) })],
      ),
      NOW,
    );
    const rows = buildCompareRows(list, DEFAULT_OFFER_WEIGHTS);
    expect(rows[0].cells[0].text).toBe('100.0');
    expect(rows[0].cells[0].note).toBe('按 2/4 维归一');
    const rated = rows.find((row) => row.key === 'rated');
    expect(rated?.cells[0].text).toBe('2/4');
    expect(rated?.cells[0].tone).toBe('warn');
  });

  it('未评的维度写「未评（不计入）」，已评的写「分 ×权重 = 贡献」', () => {
    const rows = buildCompareRows(twoOffers(), DEFAULT_OFFER_WEIGHTS);
    const salary = rows.find((row) => row.key === 'dim-salary');
    expect(salary?.label).toBe('薪资 30');
    expect(salary?.cells[0].text).toBe('5 ×30 = 30.0');
    expect(salary?.cells[1].text).toBe('未评（不计入）');
  });

  it('薪资结构：按月写「20k × 15」，按天写「400/天」，有 offer 没填钱写「薪资未填」', () => {
    const list = [
      ...twoOffers(),
      ...offerCandidatesOf(
        makeDB(
          [makeCompany('c3', 'C')],
          [makeApp('a3', 'c3', { status: 'offer', offer: makeOffer() })],
        ),
        NOW,
      ),
      // 连 offer 区块都还没有 → 这是「没拿到/没开始填」，与「填了没写钱」不是一回事
      ...offerCandidatesOf(
        makeDB([makeCompany('c4', 'D')], [makeApp('a4', 'c4', { status: 'offer' })]),
        NOW,
      ),
    ];
    const rows = buildCompareRows(list, DEFAULT_OFFER_WEIGHTS);
    const salary = rows.find((row) => row.key === 'salary');
    expect(salary?.cells.map((cell) => cell.text)).toEqual(['20k × 15', '400/天', '薪资未填', '—']);
  });

  it('签字费 / 股权 / 通勤 / 城市职级 缺省都是「—」', () => {
    const rows = buildCompareRows(twoOffers(), DEFAULT_OFFER_WEIGHTS);
    expect(rows.find((row) => row.key === 'signOn')?.cells[0].text).toBe('1 万');
    expect(rows.find((row) => row.key === 'signOn')?.cells[1].text).toBe('—');
    expect(rows.find((row) => row.key === 'equity')?.cells[0].text).toBe('5000 股');
    expect(rows.find((row) => row.key === 'commute')?.cells[0].text).toBe('35 分钟');
    expect(rows.find((row) => row.key === 'commute')?.cells[1].text).toBe('—');
    expect(rows.find((row) => row.key === 'cityLevel')?.cells[0].text).toBe('北京 · P5');
    expect(rows.find((row) => row.key === 'cityLevel')?.cells[1].text).toBe('— · —');
  });

  it('年薪合计：能算的写金额，日薪写「不能算（日薪）」并置灰', () => {
    const rows = buildCompareRows(twoOffers(), DEFAULT_OFFER_WEIGHTS);
    const annual = rows.find((row) => row.key === 'annual');
    // 20000 × 15 + 10000 签字费 = 310000
    expect(annual?.cells[0].text).toBe('31 万（不含股权）');
    expect(annual?.cells[1].text).toBe('不能算（日薪）');
    expect(annual?.cells[1].tone).toBe('muted');
  });

  it('答复截止：写「M/D（N 天）」，3 天内标黄', () => {
    const rows = buildCompareRows(twoOffers(), DEFAULT_OFFER_WEIGHTS);
    const deadline = rows.find((row) => row.key === 'deadline');
    expect(deadline?.cells[0].text).toBe('11/3（2 天）');
    expect(deadline?.cells[0].tone).toBe('warn');
    expect(deadline?.cells[1].text).toBe('—');
  });
});

describe('buildOfferAlerts · 截止与缺维提醒', () => {
  it('截止进入警戒窗口 → 一条 warn；缺 N 维 → 一条 muted', () => {
    const db = makeDB(
      [makeCompany('c1', '字节跳动', '字节')],
      [
        makeApp('a1', 'c1', {
          status: 'offer',
          deadlineAt: '2026-11-03',
          offer: makeOffer({ scores: { salary: 5 } }),
        }),
      ],
    );
    const alerts = buildOfferAlerts(offerCandidatesOf(db, NOW), db.settings, NOW);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toEqual({
      kind: 'deadline',
      appId: 'a1',
      text: '字节 还有 2 天到期',
      tone: 'warn',
    });
    expect(alerts[1]).toEqual({
      kind: 'missing',
      appId: 'a1',
      text: '字节 还有 3 维没评',
      tone: 'muted',
    });
  });

  it('已过截止 / 今天截止 的文案分开写', () => {
    const overdue = makeDB(
      [makeCompany('c1', '美团')],
      [makeApp('a1', 'c1', { status: 'offer', deadlineAt: '2026-10-30' })],
    );
    expect(buildOfferAlerts(offerCandidatesOf(overdue, NOW), overdue.settings, NOW)[0].text).toBe(
      '美团 已过答复截止 2 天',
    );
    const today = makeDB(
      [makeCompany('c1', '美团')],
      [makeApp('a1', 'c1', { status: 'offer', deadlineAt: '2026-11-01' })],
    );
    expect(buildOfferAlerts(offerCandidatesOf(today, NOW), today.settings, NOW)[0].text).toBe(
      '美团 今天就要答复',
    );
  });

  it('★ 已入职的跳过两类提醒（已经不需要盯截止，也不缺决策了）', () => {
    const db = makeDB(
      [makeCompany('c1', '字节')],
      [makeApp('a1', 'c1', { status: 'onboarded', deadlineAt: '2026-11-02' })],
    );
    expect(buildOfferAlerts(offerCandidatesOf(db, NOW), db.settings, NOW)).toEqual([]);
  });

  it('公司缺失时用「这家公司」兜底', () => {
    const db = makeDB([], [makeApp('a1', 'c-missing', { status: 'offer', deadlineAt: '2026-11-02' })]);
    expect(buildOfferAlerts(offerCandidatesOf(db, NOW), db.settings, NOW)[0].text).toBe(
      '这家公司 还有 1 天到期',
    );
  });

  it('截止超出窗口 → 不提醒（不制造噪音）', () => {
    const db = makeDB(
      [makeCompany('c1', '字节')],
      [
        makeApp('a1', 'c1', {
          status: 'offer',
          deadlineAt: '2026-12-01',
          offer: makeOffer({ scores: { salary: 5, growth: 5, city: 5, wlb: 5 } }),
        }),
      ],
    );
    expect(buildOfferAlerts(offerCandidatesOf(db, NOW), db.settings, NOW)).toEqual([]);
  });
});
