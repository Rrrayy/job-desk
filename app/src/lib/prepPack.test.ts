/**
 * U1 备战包纯函数层测试。
 *
 * 三条主线：
 * 1. **固定优先级**（同类挂过 → 这家问过 → 复习到期）与**跨档去重**——
 *    一道题可能同时命中两档，只能出现一次，且按更硬的那档记来源。
 *    交错命中是三条规则叠加后**唯一的真实错误源**（静默错标），所以单独立一组用例。
 * 2. **料够就全给**：到期题全部列出，实现里不许偷偷 `slice(0, 5)`。
 * 3. **写库口径**（`withSuggestedPrepItem`）：只有 id/text/done 三个字段、
 *    done 恒 false、id 带 `p` 前缀、题干过 `clampText`。
 *
 * ★ 关于示例库（`buildSampleDB`）的实测事实，改断言前先读这两句：
 *   - **示例库 5 道题，其中 due 只有 2 道；两场面经的 `result` 都是 `passed`，
 *     所以第 1 档（同类挂过）在示例库里恒为空** —— 这是示例数据的事实，
 *     不是实现漏了规则。
 *   - 因此「每场未开始面试都 ≥ 3 条」在示例库上**不可达**（腾讯一面没有同公司历史，
 *     全库又只有 2 道 due）。**不许为了让断言变绿去放宽规则 3、或往示例库塞题** ——
 *     料不够就该少给，这是设计不是缺陷。第 1 档与交错命中的口径由合成库用例负责。
 */

import { describe, expect, it } from 'vitest';
import type { DB, Interview, InterviewExperience, Question } from '../types';
import { emptyDB } from './defaults';
import { toDateISO } from './date';
import { QUESTION_TEXT_LIMIT, isDue, statsByCompany } from './interview';
import { buildPrepPack, isUpcomingInterview, withSuggestedPrepItem, type PrepSuggestion } from './prepPack';
import { buildSampleDB } from './sample';

/** 固定时刻：示例库全部相对它生成，用它当唯一时间基准，测试就不会受运行时间影响 */
const NOW = new Date(2026, 5, 15, 10, 0, 0);
const TODAY = toDateISO(NOW);

function experience(overrides: Partial<InterviewExperience> & Pick<InterviewExperience, 'id'>): InterviewExperience {
  return {
    applicationId: null,
    companyName: '某公司',
    round: 1,
    interviewDate: '2026-05-01',
    result: 'passed',
    source: 'self',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function question(overrides: Partial<Question> & Pick<Question, 'id' | 'experienceId' | 'text'>): Question {
  return {
    category: 'algo',
    difficulty: 2,
    mastery: 0,
    tags: [],
    reviewCount: 0,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function interview(overrides: Partial<Interview> = {}): Interview {
  return {
    id: 'iv-1',
    applicationId: 'app-1',
    round: 1,
    // 不带 Z = 本地时刻，和 rules / validateV1 的语义一致，跑 TZ=UTC 也成立
    scheduledAt: '2026-06-20T14:00:00',
    format: 'video',
    result: 'pending',
    ...overrides,
  };
}

/**
 * 三档都齐的最小库：
 * - 乙公司那场**挂了**，题带 rootCause（algo 2 条、concept 1 条）→ 第 1 档
 * - 甲公司（本次面试这家）以前问过 2 题 → 第 2 档
 * - 其中「性能优化」恰好到期，「冲突解决」是别家的到期题 → 第 3 档
 */
function buildTieredDB(): DB {
  const db = emptyDB();
  db.companies = [
    { id: 'c1', name: '甲公司', shortName: '甲', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c2', name: '乙公司', shortName: '乙', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c3', name: '丙公司', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  db.applications = [
    {
      id: 'app-1',
      companyId: 'c1',
      jobTitle: '前端实习',
      status: 'scheduled',
      statusChangedAt: '2026-06-01T01:00:00.000Z',
      lastActivityAt: '2026-06-01T01:00:00.000Z',
      createdAt: '2026-06-01T01:00:00.000Z',
      updatedAt: '2026-06-01T01:00:00.000Z',
      rejectedAtRound: null,
    },
  ];
  db.interviews = [interview()];
  db.experiences = [
    experience({ id: 'exp_fail', companyName: '乙公司', interviewDate: '2026-05-20', result: 'failed' }),
    experience({ id: 'exp_self', applicationId: 'app-1', companyName: '甲公司', interviewDate: '2026-04-01' }),
    experience({ id: 'exp_other', companyName: '丙公司', interviewDate: '2026-03-01' }),
  ];
  db.questions = [
    question({ id: 'qf1', experienceId: 'exp_fail', category: 'algo', text: '手写 Promise.all', rootCause: 'conceptGap' }),
    question({ id: 'qf2', experienceId: 'exp_fail', category: 'algo', text: '手写防抖', rootCause: 'forgot', mastery: 1 }),
    question({ id: 'qf3', experienceId: 'exp_fail', category: 'concept', text: '事件循环', rootCause: 'conceptGap' }),
    // 挂过但没写 rootCause：不知道补什么，不该冒充「同类挂过」
    question({ id: 'qf4', experienceId: 'exp_fail', category: 'concept', text: '跨域方案', mastery: 2 }),
    question({ id: 'qs1', experienceId: 'exp_self', category: 'project', text: '项目难点', mastery: 1, nextReviewAt: '2026-07-01' }),
    question({
      id: 'qs2',
      experienceId: 'exp_self',
      category: 'project',
      text: '性能优化',
      mastery: 2,
      nextReviewAt: '2026-06-01',
    }),
    question({
      id: 'qd1',
      experienceId: 'exp_other',
      category: 'behavior',
      text: '冲突解决',
      mastery: 1,
      nextReviewAt: '2026-06-10',
    }),
  ];
  return db;
}

describe('isUpcomingInterview（面板出现条件）', () => {
  it('时间未到 + pending = 备战；已过 / 已取消 / 已有结果都不备战', () => {
    expect(isUpcomingInterview(interview(), NOW)).toBe(true);
    expect(isUpcomingInterview(interview({ scheduledAt: '2026-06-01T14:00:00' }), NOW)).toBe(false);
    expect(isUpcomingInterview(interview({ result: 'cancelled' }), NOW)).toBe(false);
    expect(isUpcomingInterview(interview({ result: 'passed' }), NOW)).toBe(false);
    expect(isUpcomingInterview(interview({ scheduledAt: '不是时间' }), NOW)).toBe(false);
  });
});

describe('buildPrepPack（固定优先级）', () => {
  it('★ 三档顺序不可交换：同类挂过 → 这家问过 → 复习到期', () => {
    const db = buildTieredDB();
    const pack = buildPrepPack({ db, interview: db.interviews[0], now: NOW });
    expect(pack.map((item) => item.kind)).toEqual([
      'rootCause',
      'rootCause',
      'rootCause',
      'company',
      'company',
      'due',
    ]);
  });

  it('第 1 档按「同类」聚：algo 挂过 2 次排在 concept 挂过 1 次之前', () => {
    const db = buildTieredDB();
    const pack = buildPrepPack({ db, interview: db.interviews[0], now: NOW });
    expect(pack.slice(0, 3).map((item) => item.text)).toEqual(['手写 Promise.all', '手写防抖', '事件循环']);
    expect(pack[0].source).toBe('上次挂在「算法」·概念没懂');
    expect(pack[2].source).toBe('上次挂在「八股」·概念没懂');
  });

  it('挂过但没写 rootCause 的题不进第 1 档（不知道自己挂在哪，就不该冒充证据）', () => {
    const db = buildTieredDB();
    const pack = buildPrepPack({ db, interview: db.interviews[0], now: NOW });
    expect(pack.some((item) => item.text === '跨域方案')).toBe(false);
    expect(pack.filter((item) => item.kind === 'rootCause')).toHaveLength(3);
  });

  it('★ 跨档去重：「性能优化」既这家问过又到期，只出现一次且记在更硬的第 2 档', () => {
    const db = buildTieredDB();
    const pack = buildPrepPack({ db, interview: db.interviews[0], now: NOW });
    const hits = pack.filter((item) => item.text === '性能优化');
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('company');
    expect(hits[0].source).toBe('这家问过 1 次');
    // 到期那档只剩别的公司的题
    expect(pack.filter((item) => item.kind === 'due').map((item) => item.text)).toEqual(['冲突解决']);
  });

  it('每条都带来源、key 唯一、题干非空', () => {
    const db = buildTieredDB();
    const pack = buildPrepPack({ db, interview: db.interviews[0], now: NOW });
    expect(pack.length).toBeGreaterThanOrEqual(3);
    expect(new Set(pack.map((item) => item.key)).size).toBe(pack.length);
    for (const item of pack) {
      expect(item.source.trim()).not.toBe('');
      expect(item.text.trim()).not.toBe('');
    }
  });

  it('已经在准备清单里的题不再建议（大小写 / 首尾空白不敏感）', () => {
    const db = buildTieredDB();
    db.interviews[0].prepChecklist = [{ id: 'p_1', text: '  手写防抖 ', done: false }];
    const pack = buildPrepPack({ db, interview: db.interviews[0], now: NOW });
    expect(pack.some((item) => item.text === '手写防抖')).toBe(false);
  });

  it('空库 / 没投递的面试：返回空数组而不是抛错', () => {
    const db = emptyDB();
    db.interviews = [interview()];
    expect(buildPrepPack({ db, interview: db.interviews[0], now: NOW })).toEqual([]);
  });

  it('★ 料够就全给：合成库 12 道 due → 12 条全列出，实现里不许偷偷 slice', () => {
    const db = emptyDB();
    db.companies = [{ id: 'c1', name: '甲公司', createdAt: '2026-01-01T00:00:00.000Z' }];
    db.applications = [];
    db.experiences = [experience({ id: 'exp_1', companyName: '别家', interviewDate: '2026-01-01' })];
    db.questions = Array.from({ length: 12 }, (_, index) =>
      question({
        id: `q${index}`,
        experienceId: 'exp_1',
        text: `到期题 ${index}`,
        nextReviewAt: '2026-06-01',
        mastery: (index % 3) as 0 | 1 | 2,
      }),
    );
    db.interviews = [interview()];
    const pack = buildPrepPack({ db, interview: db.interviews[0], now: NOW });
    expect(pack).toHaveLength(12);
    expect(pack.every((item) => item.kind === 'due')).toBe(true);
  });
});

/**
 * 交错命中用的库：五种题分别只命中①/只命中②/只命中③/①②同时/②③同时。
 * 公司统一叫「甲公司」，这样「同公司」与「别家」一眼能分辨。
 */
function buildCrossHitDB(): DB {
  const db = emptyDB();
  db.companies = [
    { id: 'c1', name: '甲公司', shortName: '甲', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c2', name: '乙公司', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c3', name: '丙公司', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  db.applications = [
    {
      id: 'app-1',
      companyId: 'c1',
      jobTitle: '前端实习',
      status: 'scheduled',
      statusChangedAt: '2026-06-01T01:00:00.000Z',
      lastActivityAt: '2026-06-01T01:00:00.000Z',
      createdAt: '2026-06-01T01:00:00.000Z',
      updatedAt: '2026-06-01T01:00:00.000Z',
      rejectedAtRound: null,
    },
  ];
  db.interviews = [interview()];
  db.experiences = [
    // 挂在这家 → 它的题既「同类挂过」又「这家问过」
    experience({ id: 'exp_fail_same', companyName: '甲公司', interviewDate: '2026-09-10', result: 'failed' }),
    experience({ id: 'exp_pass_same', applicationId: 'app-1', companyName: '甲公司', interviewDate: '2026-10-01' }),
    experience({ id: 'exp_fail_far', companyName: '乙公司', interviewDate: '2026-08-01', result: 'failed' }),
    experience({ id: 'exp_pass_far', companyName: '丙公司', interviewDate: '2026-07-01' }),
  ];
  const future = '2026-12-31';
  const past = '2026-06-01';
  db.questions = [
    // ①② 同时命中（挂着 + 这家问过，未到期）→ 记在更硬的第 1 档
    question({
      id: 'q_both12',
      experienceId: 'exp_fail_same',
      category: 'algo',
      text: '算法题A',
      rootCause: 'forgot',
      nextReviewAt: future,
    }),
    // ②③ 同时命中（这家问过 + 到期）→ 记在第 2 档
    question({
      id: 'q_both23',
      experienceId: 'exp_pass_same',
      category: 'project',
      text: '项目题B',
      nextReviewAt: past,
    }),
    // 只命中 ①
    question({
      id: 'q_only1',
      experienceId: 'exp_fail_far',
      category: 'algo',
      text: '算法题C',
      rootCause: 'conceptGap',
      nextReviewAt: future,
    }),
    // 只命中 ②
    question({
      id: 'q_only2',
      experienceId: 'exp_pass_same',
      category: 'concept',
      text: '八股题D',
      nextReviewAt: future,
    }),
    // 只命中 ③
    question({
      id: 'q_only3',
      experienceId: 'exp_pass_far',
      category: 'behavior',
      text: '行为题E',
      nextReviewAt: past,
    }),
  ];
  return db;
}

describe('buildPrepPack（交错命中：去重与来源归属）', () => {
  /**
   * ★ 三条规则叠加后唯一的真实错误源：一道题同时命中两档时被列两遍，
   * 或者被算到较软的那一档（来源静默错标）。这里把四种交错全造出来。
   */
  it('★ 每种交错只出现一次，来源取优先级更高的那档（① > ② > ③）', () => {
    const db = buildCrossHitDB();
    const pack = buildPrepPack({ db, interview: db.interviews[0], now: NOW });

    // 总数 = 5 道题各一次（没有因为交错命中而膨胀）
    expect(pack).toHaveLength(5);
    expect(pack.map((item) => item.text)).toEqual(['算法题A', '算法题C', '项目题B', '八股题D', '行为题E']);
    expect(pack.map((item) => item.kind)).toEqual(['rootCause', 'rootCause', 'company', 'company', 'due']);

    const byText = new Map(pack.map((item) => [item.text, item]));
    // ①② 同时命中 → 归第 1 档，来源写「上次挂在…」，不写「这家问过」
    expect(byText.get('算法题A')?.kind).toBe('rootCause');
    expect(byText.get('算法题A')?.source).toBe('上次挂在「算法」·写过忘了');
    // ②③ 同时命中 → 归第 2 档，来源写「这家问过」，不写「复习到期」
    expect(byText.get('项目题B')?.kind).toBe('company');
    expect(byText.get('项目题B')?.source).toBe('这家问过 1 次');
    // 只命中一档的三种
    expect(byText.get('算法题C')?.source).toBe('上次挂在「算法」·概念没懂');
    expect(byText.get('八股题D')?.source).toBe('这家问过 1 次');
    expect(byText.get('行为题E')?.source).toBe('复习到期 · 2026-06-01');

    // 没有任何题干出现两次
    const texts = pack.map((item) => item.text.trim().toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('buildSampleDB（示例库整库口径）', () => {
  /**
   * ★ 示例库的实测底数（2026-06-15 为基准，`sample.ts` 改了就重算这两行）：
   * - 5 道题、**只有 2 道到期**（`at(now, daysAgo)` 的负数表示未来，很容易看反）；
   * - 两场面经都是 `passed` → 第 1 档（同类挂过）在示例库里恒为空；
   * - 未开始的面试只有 2 场：阿里二面（有同公司历史）、腾讯一面（只有到期题）。
   *
   * 所以「每场未开始面试都 ≥ 3 条」在这份数据上**不可达**：腾讯那场没有同公司历史，
   * 全库又只有 2 道到期题 —— 这是**数据不够**，不是实现 bug；**不许为了让断言变绿
   * 去放宽规则 3 或往示例库塞题**。料不够就该少给，这是设计不是缺陷。
   * 下面的断言按真实可达的边界写，缺口处显式钉住数字。
   */
  const SAMPLE_DUE = 2;

  it('示例库 8 家公司；每场未开始面试的包都非空、每项带来源、按固定优先级排、无重复', () => {
    const db = buildSampleDB(NOW);
    expect(db.companies).toHaveLength(8);

    const upcoming = db.interviews.filter((item) => isUpcomingInterview(item, NOW));
    // 至少一场，否则下面的循环是空转
    expect(upcoming.length).toBeGreaterThan(0);

    const rank = { rootCause: 0, company: 1, due: 2 } as const;
    for (const target of upcoming) {
      const pack = buildPrepPack({ db, interview: target, now: NOW });
      expect(pack.length, `${target.id} 的包是空的`).toBeGreaterThan(0);

      // 优先级只许「从硬到软」，不许倒挂
      const ranks = pack.map((item) => rank[item.kind]);
      expect(ranks, `${target.id} 的档位顺序倒挂了`).toEqual([...ranks].sort((a, b) => a - b));

      const seen = new Set<string>();
      for (const item of pack as PrepSuggestion[]) {
        expect(item.source.trim(), `${target.id} 有一条建议没写来源`).not.toBe('');
        expect(item.text.trim()).not.toBe('');
        const key = item.text.trim().toLowerCase();
        expect(seen.has(key), `${target.id} 的建议里「${item.text}」重复了`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('★ 有同公司历史的未开始面试（阿里二面）→ 预填项 ≥ 3、每项带来源，且这家问过的题全在最前面', () => {
    const db = buildSampleDB(NOW);
    const alibaba = db.interviews.find((item) => item.id === 'iv_alibaba_2') as Interview;
    expect(isUpcomingInterview(alibaba, NOW)).toBe(true);

    const pack = buildPrepPack({ db, interview: alibaba, now: NOW });
    expect(pack.length).toBeGreaterThanOrEqual(3);
    for (const item of pack) {
      expect(item.source.trim(), `「${item.text}」没写来源`).not.toBe('');
    }

    const stat = statsByCompany(db).find((entry) => entry.companyName === '阿里巴巴');
    expect(stat).toBeDefined();
    const companyCount = (stat as { items: unknown[] }).items.length;
    expect(companyCount).toBe(3);
    // 第 2 档整体排在到期题之前，且题数与「这家问过」的去重题数一致
    expect(pack.slice(0, companyCount).every((item) => item.kind === 'company')).toBe(true);
    expect(pack.filter((item) => item.kind === 'company')).toHaveLength(companyCount);
  });

  it('★ 只有到期题的那场（腾讯一面）：条数 = 全库 due 数（2）、每项带来源、优先级单调、无重复', () => {
    const db = buildSampleDB(NOW);
    const dueCount = db.questions.filter((item) => isDue(item, TODAY)).length;
    expect(dueCount).toBe(SAMPLE_DUE);

    const tencent = db.interviews.find((item) => item.id === 'iv_tencent_1') as Interview;
    expect(isUpcomingInterview(tencent, NOW)).toBe(true);
    const pack = buildPrepPack({ db, interview: tencent, now: NOW });

    // 料只有 2 道 due → 就给 2 条。**少给是正确的**，不是缺陷。
    expect(pack).toHaveLength(SAMPLE_DUE);
    expect(pack.every((item) => item.kind === 'due')).toBe(true);
    for (const item of pack) {
      expect(item.source.trim(), `「${item.text}」没写来源`).not.toBe('');
    }

    const rank = { rootCause: 0, company: 1, due: 2 } as const;
    const ranks = pack.map((item) => rank[item.kind]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    const texts = pack.map((item) => item.text.trim().toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('示例库里两场面经都是 passed → 第 1 档为空（这正是它测不到第 1 档的原因）', () => {
    const db = buildSampleDB(NOW);
    expect(db.experiences.every((item) => item.result !== 'failed')).toBe(true);
    for (const target of db.interviews.filter((item) => isUpcomingInterview(item, NOW))) {
      const pack = buildPrepPack({ db, interview: target, now: NOW });
      expect(pack.some((item) => item.kind === 'rootCause')).toBe(false);
    }
  });
});

describe('withSuggestedPrepItem（写库口径）', () => {
  const makeId = (prefix: string): string => `${prefix}_fixed`;

  it('★ 只产出 id/text/done 三个字段，且 done 恒为 false', () => {
    const result = withSuggestedPrepItem([], '手写防抖', makeId);
    expect(result.added).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.next).toEqual([{ id: 'p_fixed', text: '手写防抖', done: false }]);
    // 字段集合精确断言：多一个 source 字段这里就红（validateV1 的白名单会把它剥掉）
    expect(Object.keys(result.next[0]).sort()).toEqual(['done', 'id', 'text']);
  });

  it('题干 trim 后写入', () => {
    const result = withSuggestedPrepItem([], '  事件循环  ', makeId);
    expect(result.next[0].text).toBe('事件循环');
  });

  it('★ 超长题干被 clampText 截到 2000 字并标记 truncated（校验器不会帮你截）', () => {
    const long = 'a'.repeat(QUESTION_TEXT_LIMIT + 5);
    const result = withSuggestedPrepItem([], long, makeId);
    expect(result.added).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.next[0].text).toHaveLength(QUESTION_TEXT_LIMIT);
  });

  it('已在清单里（归一化题干相同）→ 不改清单，返回 added:false', () => {
    const checklist = [{ id: 'p_1', text: 'Vite 打包', done: false }];
    const result = withSuggestedPrepItem(checklist, '  vite 打包 ', makeId);
    expect(result.added).toBe(false);
    expect(result.next).toBe(checklist);
  });

  it('空题干不写入', () => {
    const result = withSuggestedPrepItem([], '   ', makeId);
    expect(result.added).toBe(false);
    expect(result.next).toEqual([]);
  });

  it('追加而不是覆盖：原有条目原样保留、顺序不变', () => {
    const checklist = [
      { id: 'p_1', text: '第一条', done: true },
      { id: 'p_2', text: '第二条', done: false },
    ];
    const result = withSuggestedPrepItem(checklist, '第三条', makeId);
    expect(result.next.map((item) => item.text)).toEqual(['第一条', '第二条', '第三条']);
    expect(result.next[0]).toBe(checklist[0]);
  });
});
