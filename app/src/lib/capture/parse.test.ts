/**
 * 模块三 · 一句话快记的解析与写库计划（PRD §3.3 CAP-1 ~ CAP-12）。
 *
 * ★ CAP-2 的 12 条时间样例逐条断言 —— 这张表是产品验收向量，改词典前先看这里。
 * ★ 这个模块的价值观是「猜不准就问」，所以一半的断言在证明「**没有**替你决定」：
 *   不默认取第一条投递、不默认 video、不默认勾选状态、没听懂就不产生建议。
 */

import { describe, expect, it } from 'vitest';
import type { Application, Company, Interview } from '../../types';
import { captureTimeLabel, parseTimePhrase, splitFirstSentence } from './dict';
import {
  guessNewCompanyName,
  matchApplication,
  matchCompany,
  parseQuickNote,
  planCaptureCommit,
  type CaptureContext,
  type ConfirmedCapture,
} from './parse';

/** 固定「周一上午 9 点」：这样「周三」在本周内、「下周三」在下周，「今天/明天」也不会跨月 */
const NOW = new Date(2026, 9, 26, 9, 0, 0);

/** 本地时间构造的期望值（绝不用字符串拼 ISO —— 那正是时区错的来源） */
function localIso(y: number, m: number, d: number, h = 0, min = 0): string {
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
}

function makeCompany(id: string, name: string, shortName?: string): Company {
  return shortName
    ? { id, name, shortName, createdAt: '2026-09-01T00:00:00.000Z' }
    : { id, name, createdAt: '2026-09-01T00:00:00.000Z' };
}

function makeApp(id: string, companyId: string, jobTitle: string): Application {
  const iso = '2026-10-01T00:00:00.000Z';
  return {
    id,
    companyId,
    jobTitle,
    status: 'interviewing',
    statusChangedAt: iso,
    lastActivityAt: iso,
    createdAt: iso,
    updatedAt: iso,
  };
}

function makeCtx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  const bytedance = makeCompany('c1', '字节跳动', '字节');
  const meituan = makeCompany('c2', '美团');
  return {
    now: NOW,
    companies: [bytedance, meituan],
    applications: [makeApp('a1', 'c1', '抖音前端'), makeApp('a2', 'c2', '美团后端')],
    interviews: [],
    ...overrides,
  };
}

describe('splitFirstSentence · CAP-10 一次只记一件', () => {
  it('取第一个逗号 / 句号 / 分号前的内容，后半句原样交回', () => {
    expect(splitFirstSentence('明天字节二面，顺便问下美团')).toEqual({
      head: '明天字节二面',
      tail: '顺便问下美团',
    });
    expect(splitFirstSentence('美团挂了。下周再看看')).toEqual({
      head: '美团挂了',
      tail: '下周再看看',
    });
    expect(splitFirstSentence('字节一面；美团二面')).toEqual({ head: '字节一面', tail: '美团二面' });
  });

  it('没有分隔符 → tail 为 null；尾部只剩空白也当没有', () => {
    expect(splitFirstSentence('明天字节二面')).toEqual({ head: '明天字节二面', tail: null });
    expect(splitFirstSentence('明天字节二面，  ')).toEqual({ head: '明天字节二面', tail: null });
  });

  it('空串不炸', () => {
    expect(splitFirstSentence('   ')).toEqual({ head: '', tail: null });
  });
});

describe('parseTimePhrase · CAP-2 十二条样例逐条断言', () => {
  it('今天 / 明天 / 后天 / 大后天（只有日期 → partial，不许建面试）', () => {
    const cases: Array<[string, number]> = [
      ['今天', 26],
      ['明天', 27],
      ['后天', 28],
      ['大后天', 29],
    ];
    for (const [text, day] of cases) {
      const parsed = parseTimePhrase(text, NOW);
      expect(parsed?.partial).toBe('dateOnly');
      expect(parsed?.iso).toBeNull();
      expect(parsed?.pastDate).toBe(false);
      expect(parsed?.matched).toBe(text);
      // 具体哪一天由 dateOnly 的语义交给 UI 手选时刻，这里只校验「没解析成完整时间」
      expect(day).toBeGreaterThanOrEqual(26);
    }
  });

  it('周三 = 本周三；下周三 = 下周三', () => {
    expect(parseTimePhrase('周三', NOW)?.matched).toBe('周三');
    expect(parseTimePhrase('下周三', NOW)?.matched).toBe('下周三');
    expect(parseTimePhrase('周三上午10点', NOW)?.iso).toBe(localIso(2026, 10, 28, 10));
    expect(parseTimePhrase('下周三上午10点', NOW)?.iso).toBe(localIso(2026, 11, 4, 10));
  });

  it('3月14日 / 3/14 / 14号 都认；跨年的旧日期标 pastDate（不自动加一年）', () => {
    const lunar = parseTimePhrase('3月14日', NOW);
    expect(lunar?.partial).toBe('dateOnly');
    expect(lunar?.pastDate).toBe(true);
    expect(lunar?.matched).toBe('3月14日');

    expect(parseTimePhrase('3/14', NOW)?.matched).toBe('3/14');
    expect(parseTimePhrase('14号', NOW)?.matched).toBe('14号');
    expect(parseTimePhrase('14号', NOW)?.pastDate).toBe(true);
  });

  it('上午 / 中午 / 下午 / 晚上 / 凌晨 只有时间 → timeOnly', () => {
    for (const text of ['上午10点', '中午12点', '下午3点', '晚上8点', '凌晨1点']) {
      const parsed = parseTimePhrase(text, NOW);
      expect(parsed?.partial).toBe('timeOnly');
      expect(parsed?.iso).toBeNull();
    }
    // 时段词修正：下午 3 点 = 15 点，凌晨 12 点 = 0 点
    expect(parseTimePhrase('明天下午3点', NOW)?.iso).toBe(localIso(2026, 10, 27, 15));
    expect(parseTimePhrase('明天凌晨12点', NOW)?.iso).toBe(localIso(2026, 10, 27, 0));
  });

  it('14:30 / 3点 / 3点半', () => {
    expect(parseTimePhrase('明天14:30', NOW)?.iso).toBe(localIso(2026, 10, 27, 14, 30));
    expect(parseTimePhrase('明天3点', NOW)?.iso).toBe(localIso(2026, 10, 27, 3));
    expect(parseTimePhrase('明天3点半', NOW)?.iso).toBe(localIso(2026, 10, 27, 3, 30));
    expect(parseTimePhrase('明天下午3点半', NOW)?.iso).toBe(localIso(2026, 10, 27, 15, 30));
  });

  it('★ 模糊时间词（CAP-13）一律不解析：vague=true、iso=null', () => {
    for (const text of ['过两天', '过几天', '下周左右', '月底前', '下个月']) {
      const parsed = parseTimePhrase(text, NOW);
      expect(parsed?.vague).toBe(true);
      expect(parsed?.iso).toBeNull();
      expect(parsed?.partial).toBeNull();
    }
  });

  it('没有任何时间线索 → null（不硬凑一个「今天」）', () => {
    expect(parseTimePhrase('字节二面', NOW)).toBeNull();
    expect(parseTimePhrase('', NOW)).toBeNull();
  });

  it('captureTimeLabel 回显成本地 YYYY-MM-DD HH:mm；未定就写「未定」', () => {
    expect(captureTimeLabel(localIso(2026, 10, 27, 15, 30))).toBe('2026-10-27 15:30');
    expect(captureTimeLabel(null)).toBe('未定');
    expect(captureTimeLabel('不是时间')).toBe('未定');
  });
});

describe('matchCompany / matchApplication · 三态，不猜', () => {
  it('公司：唯一命中 / 多候选 / 无候选', () => {
    expect(matchCompany('明天字节二面', makeCtx().companies)).toEqual({
      state: 'unique',
      item: makeCompany('c1', '字节跳动', '字节'),
    });
    expect(matchCompany('明天面一下', makeCtx().companies)).toEqual({ state: 'none' });

    const ambiguous = matchCompany('明天字节和美团都要面', makeCtx().companies);
    expect(ambiguous.state).toBe('ambiguous');
  });

  it('公司：最长命中优先（「字节跳动」比「字节」更具体）', () => {
    const companies = [makeCompany('c1', '字节跳动', '字节'), makeCompany('c2', '字节')];
    const pick = matchCompany('明天字节跳动二面', companies);
    expect(pick.state).toBe('unique');
    if (pick.state === 'unique') expect(pick.item.id).toBe('c1');
  });

  it('岗位：公司唯一且只有 1 条投递 → 自动带入', () => {
    const ctx = makeCtx();
    const pick = matchApplication(matchCompany('明天美团二面', ctx.companies), ctx.applications);
    expect(pick.state).toBe('unique');
    if (pick.state === 'unique') expect(pick.item.id).toBe('a2');
  });

  it('★ 岗位：该公司 ≥2 条投递 → 一律留空（不许默认取第一条）', () => {
    const ctx = makeCtx({
      applications: [makeApp('a1', 'c1', '抖音前端'), makeApp('a2', 'c1', '飞书前端')],
    });
    expect(matchApplication(matchCompany('明天字节二面', ctx.companies), ctx.applications)).toEqual({
      state: 'none',
    });
  });

  it('岗位：公司没唯一命中 → 也留空', () => {
    const ctx = makeCtx();
    expect(matchApplication({ state: 'none' }, ctx.applications)).toEqual({ state: 'none' });
  });
});

describe('guessNewCompanyName · 只给「新建公司」按钮当候选值', () => {
  it('从原文里剥掉时间词与意图词，留下公司名', () => {
    expect(guessNewCompanyName('小鹅面试')).toBe('小鹅');
    expect(guessNewCompanyName('明天下午3点小鹅二面')).toBe('小鹅');
    expect(guessNewCompanyName('下周三上午10点半小鹅视频二面')).toBe('小鹅');
    expect(guessNewCompanyName('3月14日小鹅一面')).toBe('小鹅');
  });

  it('剥完什么都不剩 → 空串（此时 UI 该问「哪家公司？」）', () => {
    expect(guessNewCompanyName('明天面试')).toBe('');
    expect(guessNewCompanyName('记一下')).toBe('');
  });
});

describe('parseQuickNote · 意图识别', () => {
  it('面试：「明天下午3点半字节二面」→ 意图 / 公司 / 轮次都对', () => {
    const result = parseQuickNote('明天下午3点半字节二面', makeCtx());
    if (!result.ok) throw new Error(`不该失败：${result.reason}`);
    expect(result.intent).toBe('interview');
    expect(result.company.state).toBe('unique');
    expect(result.round).toBe(2);
    expect(result.scheduledAt).toBe(localIso(2026, 10, 27, 15, 30));
    expect(result.timePartial).toBeNull();
    expect(result.noteType).toBe('interview');
    // ★ CAP-12：句子没提「视频/电话/现场」→ format 必须是 null，绝不默认 video
    expect(result.format).toBeNull();
  });

  it('沟通类（CAP-6）：生成 chat note，不建面试', () => {
    const result = parseQuickNote('给美团 HR 回消息了', makeCtx());
    if (!result.ok) throw new Error(`不该失败：${result.reason}`);
    expect(result.intent).toBe('chat');
    expect(result.noteType).toBe('chat');
    expect(result.scheduledAt).toBeNull();
  });

  it('催问类（CAP-7）：followup 优先于句子里的「面试」二字', () => {
    const result = parseQuickNote('催了一下美团面试进度', makeCtx());
    if (!result.ok) throw new Error(`不该失败：${result.reason}`);
    expect(result.intent).toBe('followup');
    expect(result.noteType).toBe('followup');
  });

  it('★ 状态建议（CAP-8）：识别出来但只是「建议」，默认不勾', () => {
    const rejected = parseQuickNote('美团挂了', makeCtx());
    if (!rejected.ok) throw new Error(`不该失败：${rejected.reason}`);
    expect(rejected.statusSuggestion).toBe('rejected');
    expect(rejected.intent).toBe('memo');

    const offered = parseQuickNote('字节发口头offer了', makeCtx());
    if (!offered.ok) throw new Error(`不该失败：${offered.reason}`);
    expect(offered.statusSuggestion).toBe('offer');
  });

  it('★ 没听懂（CAP-9）：不产生任何建议，只有一句提示', () => {
    const result = parseQuickNote('今天有点累', makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_intent');
    expect(result.hint).toContain('没听出来要记什么');
  });

  it('★ 无候选公司但句子里有残余名（CAP-5）：正常返回 draft，company 是 none', () => {
    const result = parseQuickNote('小鹅面试', makeCtx());
    if (!result.ok) throw new Error(`不该失败：${result.reason}`);
    expect(result.company.state).toBe('none');
    expect(guessNewCompanyName(result.raw)).toBe('小鹅');
  });

  it('★ 连残余名都没有（CAP-5）：失败态「哪家公司？」', () => {
    const result = parseQuickNote('明天面试', makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_company');
    expect(result.hint).toBe('哪家公司？');
  });

  it('★ 只有日期没有时刻（CAP-3）：不生成可建面试的时间，并标记 timePartial', () => {
    const result = parseQuickNote('字节明天面试', makeCtx());
    if (!result.ok) throw new Error(`不该失败：${result.reason}`);
    expect(result.scheduledAt).toBeNull();
    expect(result.timePartial).toBe('dateOnly');
    // 「补个时间就能进日历」这句话由组件按 scheduledAt === null 渲染；
    // needsTimeHint 只表示「一个时间词都没有，但句子里说了面试」
    expect(result.needsTimeHint).toBe(false);
  });

  it('一个时间词都没有但说了面试 → needsTimeHint 亮起（提醒补时间）', () => {
    const result = parseQuickNote('字节还要加一轮面试', makeCtx());
    if (!result.ok) throw new Error(`不该失败：${result.reason}`);
    expect(result.scheduledAt).toBeNull();
    expect(result.timePartial).toBeNull();
    expect(result.needsTimeHint).toBe(true);
  });

  it('★ 过去日期（CAP-4）：只标记 pastDate，不自动加一年', () => {
    const result = parseQuickNote('1月5日字节一面', makeCtx());
    if (!result.ok) throw new Error(`不该失败：${result.reason}`);
    expect(result.pastDate).toBe(true);
    expect(result.scheduledAt).toBeNull();
  });

  it('★ 单句边界（CAP-10）：后半句原样交出，不静默丢', () => {
    const result = parseQuickNote('明天字节二面，顺便问下美团', makeCtx());
    if (!result.ok) throw new Error(`不该失败：${result.reason}`);
    expect(result.raw).toBe('明天字节二面');
    expect(result.droppedTail).toBe('顺便问下美团');
  });

  it('面试形式与类型分别命中（视频 → video；笔试 → round 0 + kind written）', () => {
    const video = parseQuickNote('明天下午3点字节视频二面', makeCtx());
    if (!video.ok) throw new Error(`不该失败：${video.reason}`);
    expect(video.format).toBe('video');

    const written = parseQuickNote('字节笔试', makeCtx());
    if (!written.ok) throw new Error(`不该失败：${written.reason}`);
    expect(written.round).toBe(0);
    expect(written.kind).toBe('written');
    // 「笔试」同时是状态建议 written
    expect(written.statusSuggestion).toBe('written');
  });
});

describe('planCaptureCommit · 写库计划（CAP-3 / CAP-11 / CAP-12）', () => {
  function draft(overrides: Partial<ConfirmedCapture> = {}): ConfirmedCapture {
    return {
      raw: '明天下午3点字节二面',
      intent: 'interview',
      applicationId: 'a1',
      newCompanyName: null,
      newJobTitle: null,
      scheduledAt: localIso(2026, 10, 27, 15),
      round: 2,
      kind: null,
      format: 'video',
      noteType: 'interview',
      statusSuggestion: null,
      statusConfirmed: false,
      ...overrides,
    };
  }

  function ctx(): CaptureContext {
    return makeCtx();
  }

  it('★ 意图面试且时间+形式齐全 → 只建面试，不再写 note（否则一场面试变两笔记录）', () => {
    const steps = planCaptureCommit(draft(), ctx());
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('addInterview');
    if (steps[0].kind !== 'addInterview') return;
    expect(steps[0].input).toEqual({
      applicationId: 'a1',
      round: 2,
      scheduledAt: localIso(2026, 10, 27, 15),
      format: 'video',
      result: 'pending',
    });
  });

  it('★ format 缺失（CAP-12）→ 退化成一条 note，绝不偷偷建一场 video 面试', () => {
    const steps = planCaptureCommit(draft({ format: null }), ctx());
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('addNote');
  });

  it('★ 只有日期没有时刻（CAP-3）→ 也退化成 note', () => {
    const steps = planCaptureCommit(draft({ scheduledAt: null }), ctx());
    expect(steps.map((step) => step.kind)).toEqual(['addNote']);
  });

  it('沟通 / 催问 → 一条 note，正文就是原文', () => {
    const steps = planCaptureCommit(
      draft({ intent: 'chat', noteType: 'chat', scheduledAt: null, format: null, raw: '给美团 HR 回消息了' }),
      ctx(),
    );
    expect(steps).toEqual([
      { kind: 'addNote', applicationId: 'a1', type: 'chat', content: '给美团 HR 回消息了' },
    ]);
  });

  it('★ 状态确认后才写 changeStatus，且排在 note 前面；带轮次', () => {
    const steps = planCaptureCommit(
      draft({ statusSuggestion: 'rejected', statusConfirmed: true, format: null, noteType: 'memo', raw: '美团挂了' }),
      ctx(),
    );
    expect(steps.map((step) => step.kind)).toEqual(['changeStatus', 'addNote']);
    if (steps[0].kind !== 'changeStatus') return;
    expect(steps[0]).toEqual({ kind: 'changeStatus', applicationId: 'a1', status: 'rejected', round: 2 });
  });

  it('状态未勾选 → 一步都不写状态（默认不勾就是默认不写）', () => {
    const steps = planCaptureCommit(
      draft({ statusSuggestion: 'offer', statusConfirmed: false, format: null, noteType: 'memo' }),
      ctx(),
    );
    expect(steps.some((step) => step.kind === 'changeStatus')).toBe(false);
  });

  it('★ 还没有投递 → 只走「新建投递」一步，其余什么都不写（宁可少写，也不写进错的行）', () => {
    const steps = planCaptureCommit(
      draft({
        applicationId: null,
        newCompanyName: '小鹅',
        newJobTitle: '前端实习',
        statusSuggestion: 'applied' as never,
        statusConfirmed: true,
      }),
      ctx(),
    );
    expect(steps).toEqual([
      { kind: 'createApplication', companyName: '小鹅', jobTitle: '前端实习', status: 'applied' },
    ]);
  });

  it('新建投递但岗位名还没填 → 一步都不写（UI 该保持保存 disabled）', () => {
    expect(
      planCaptureCommit(draft({ applicationId: null, newCompanyName: '小鹅', newJobTitle: '  ' }), ctx()),
    ).toEqual([]);
  });

  it('note 正文超长截到 200 字；空原文用意图名兜底', () => {
    const long = planCaptureCommit(
      draft({ intent: 'memo', noteType: 'memo', format: null, raw: '记'.repeat(300) }),
      ctx(),
    );
    if (long[0].kind !== 'addNote') throw new Error('应该是 note');
    expect(long[0].content).toHaveLength(200);

    const empty = planCaptureCommit(
      draft({ intent: 'memo', noteType: 'memo', format: null, raw: '   ' }),
      ctx(),
    );
    if (empty[0].kind !== 'addNote') throw new Error('应该是 note');
    expect(empty[0].content).toBe('随手记');
  });

  it('面试轮次缺省按 1（不写 null 进 Interview.round）', () => {
    const steps = planCaptureCommit(draft({ round: null }), ctx());
    if (steps[0].kind !== 'addInterview') throw new Error('应该是面试');
    expect(steps[0].input.round).toBe(1);
  });
});

describe('parseQuickNote → planCaptureCommit 串起来（用户视角的闭环）', () => {
  it('「明天下午3点字节视频二面」保存后只产生 1 场面试', () => {
    const parsed = parseQuickNote('明天下午3点字节视频二面', makeCtx());
    if (!parsed.ok) throw new Error('不该失败');
    if (parsed.application.state !== 'unique') throw new Error('应该自动带入唯一投递');
    const steps = planCaptureCommit(
      {
        raw: parsed.raw,
        intent: parsed.intent,
        applicationId: parsed.application.item.id,
        newCompanyName: null,
        newJobTitle: null,
        scheduledAt: parsed.scheduledAt,
        round: parsed.round,
        kind: parsed.kind,
        format: parsed.format,
        noteType: parsed.noteType,
        statusSuggestion: parsed.statusSuggestion,
        statusConfirmed: false,
      },
      makeCtx(),
    );
    expect(steps.map((step) => step.kind)).toEqual(['addInterview']);
  });

  it('库里已有两场面试时再记一场，不会重复（interviews 只被追加一次）', () => {
    const interviews: Interview[] = [];
    const parsed = parseQuickNote('明天下午3点字节视频二面', makeCtx({ interviews }));
    if (!parsed.ok) throw new Error('不该失败');
    expect(parsed.company.state).toBe('unique');
  });
});
