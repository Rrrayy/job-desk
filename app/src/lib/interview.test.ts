import { describe, expect, it } from 'vitest';
import type { DB, Interview, InterviewExperience, Question } from '../types';
import { emptyDB } from './defaults';
import {
  QUESTION_TEXT_LIMIT,
  applyQuestionEdit,
  buildQuestionRows,
  bumpMastery,
  deriveInitialNextReviewAt,
  isDue,
  masteryCounts,
  nextReviewAtFor,
  pendingReviewInterviews,
  reviewQueue,
  revertQuestionBatch,
  revertQuestionEdit,
  sortQuestionsForReview,
  statsByCategory,
  statsByCompany,
  statsByRootCause,
} from './interview';

const NOW = '2025-03-13T12:00:00.000Z';

function question(overrides: Partial<Question>): Question {
  return {
    id: 'q_1',
    experienceId: 'exp_1',
    category: 'algo',
    difficulty: 2,
    text: '手写 Promise.all',
    mastery: 0,
    tags: [],
    reviewCount: 0,
    createdAt: '2025-03-10T10:00:00.000Z',
    updatedAt: '2025-03-10T10:00:00.000Z',
    ...overrides,
  };
}

function experience(overrides: Partial<InterviewExperience>): InterviewExperience {
  return {
    id: 'exp_1',
    applicationId: 'app_1',
    companyName: '字节跳动',
    jobTitle: '抖音前端',
    round: 1,
    interviewDate: '2025-03-12',
    result: 'failed',
    source: 'self',
    createdAt: '2025-03-12T10:00:00.000Z',
    updatedAt: '2025-03-12T10:00:00.000Z',
    ...overrides,
  };
}

function interview(overrides: Partial<Interview>): Interview {
  return {
    id: 'iv_1',
    applicationId: 'app_1',
    round: 1,
    scheduledAt: '2025-03-10T14:00:00.000Z',
    format: 'video',
    result: 'passed',
    ...overrides,
  };
}

describe('排序：mastery 0 → 1 → 2，组内 nextReviewAt 升序', () => {
  it('不会的永远排最前', () => {
    const list = [
      question({ id: 'a', mastery: 2, nextReviewAt: '2025-03-01' }),
      question({ id: 'b', mastery: 0, nextReviewAt: '2025-03-20' }),
      question({ id: 'c', mastery: 1, nextReviewAt: '2025-03-02' }),
    ];
    expect(sortQuestionsForReview(list, NOW).map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });

  it('同组内按 nextReviewAt 升序，没设的排末尾', () => {
    const list = [
      question({ id: 'no-date', mastery: 0 }),
      question({ id: 'late', mastery: 0, nextReviewAt: '2025-03-25' }),
      question({ id: 'soon', mastery: 0, nextReviewAt: '2025-03-14' }),
    ];
    expect(sortQuestionsForReview(list, NOW).map((item) => item.id)).toEqual(['soon', 'late', 'no-date']);
  });

  it('不改入参数组', () => {
    const list = [question({ id: 'a', mastery: 2 }), question({ id: 'b', mastery: 0 })];
    const snapshot = list.map((item) => item.id);
    sortQuestionsForReview(list, NOW);
    expect(list.map((item) => item.id)).toEqual(snapshot);
  });

  it('到期未复习的置顶（在 mastery 相同的组内）', () => {
    const list = [
      question({ id: 'future', mastery: 1, nextReviewAt: '2025-04-01' }),
      question({ id: 'overdue', mastery: 1, nextReviewAt: '2025-03-01' }),
    ];
    expect(sortQuestionsForReview(list, NOW)[0].id).toBe('overdue');
  });

  it('reviewQueue 把到期的排在前面', () => {
    const list = [
      question({ id: 'later', mastery: 0, nextReviewAt: '2025-04-01' }),
      question({ id: 'due', mastery: 2, nextReviewAt: '2025-03-01' }),
    ];
    expect(reviewQueue(list, NOW)[0].id).toBe('due');
  });

  it('isDue 对没设日期的一律 false（不把新题当天塞给你）', () => {
    expect(isDue(question({ nextReviewAt: undefined }), '2025-03-13')).toBe(false);
    expect(isDue(question({ nextReviewAt: '2025-03-13' }), '2025-03-13')).toBe(true);
  });
});

describe('间隔复习', () => {
  it('初始复习日取 interviewDate + 1/3/7 中第一个 ≥ 今天', () => {
    expect(deriveInitialNextReviewAt('2025-03-12', NOW)).toBe('2025-03-13');
    expect(deriveInitialNextReviewAt('2025-03-01', NOW)).toBe('2025-03-08');
  });

  it('三个节点都过了就取 +7', () => {
    expect(deriveInitialNextReviewAt('2025-02-01', NOW)).toBe('2025-02-08');
  });

  it('非法日期退化为今天，不 throw', () => {
    expect(deriveInitialNextReviewAt('不是日期', NOW)).toBe('2025-03-13');
  });

  it('复习后：0 → +3、1 → +7、2 → +14，上限 14 天', () => {
    expect(nextReviewAtFor(0, '2025-03-13')).toBe('2025-03-16');
    expect(nextReviewAtFor(1, '2025-03-13')).toBe('2025-03-20');
    expect(nextReviewAtFor(2, '2025-03-13')).toBe('2025-03-27');
  });

  it('bumpMastery 到 2 就停', () => {
    expect(bumpMastery(0)).toBe(1);
    expect(bumpMastery(1)).toBe(2);
    expect(bumpMastery(2)).toBe(2);
  });
});

describe('待复盘（唯一数据源）', () => {
  it('已过 + 已记结果 + 没有面经 → 待复盘', () => {
    const db = emptyDB();
    db.companies.push({ id: 'c_1', name: '字节跳动', createdAt: NOW });
    db.applications.push({
      id: 'app_1',
      companyId: 'c_1',
      jobTitle: '抖音前端',
      status: 'interviewing',
      statusChangedAt: NOW,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.interviews.push(interview({ id: 'iv_1', result: 'failed' }));
    const pending = pendingReviewInterviews(db, new Date(NOW));
    expect(pending).toHaveLength(1);
    expect(pending[0].companyName).toBe('字节跳动');
  });

  it('已经有面经的不再提醒', () => {
    const db = emptyDB();
    db.companies.push({ id: 'c_1', name: '字节跳动', createdAt: NOW });
    db.applications.push({
      id: 'app_1',
      companyId: 'c_1',
      jobTitle: '抖音前端',
      status: 'interviewing',
      statusChangedAt: NOW,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.interviews.push(interview({ id: 'iv_1', result: 'failed' }));
    db.experiences.push(experience({ id: 'exp_1' }));
    expect(pendingReviewInterviews(db, new Date(NOW))).toHaveLength(0);
  });

  it('pending 结果 / cancelled / 未来面试 都不算待复盘', () => {
    const db = emptyDB();
    db.companies.push({ id: 'c_1', name: '字节跳动', createdAt: NOW });
    db.applications.push({
      id: 'app_1',
      companyId: 'c_1',
      jobTitle: '抖音前端',
      status: 'interviewing',
      statusChangedAt: NOW,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.interviews.push(interview({ id: 'iv_pending', result: 'pending' }));
    db.interviews.push(interview({ id: 'iv_cancelled', result: 'cancelled' }));
    db.interviews.push(
      interview({ id: 'iv_future', result: 'passed', scheduledAt: '2025-04-01T14:00:00.000Z' }),
    );
    expect(pendingReviewInterviews(db, new Date(NOW))).toHaveLength(0);
  });
});

describe('统计', () => {
  function statsDB(): DB {
    const db = emptyDB();
    db.experiences.push(
      experience({ id: 'exp_a', companyName: '字节跳动', result: 'failed' }),
      experience({ id: 'exp_b', companyName: '美团', result: 'failed' }),
      experience({ id: 'exp_c', companyName: '美团', result: 'passed' }),
    );
    db.questions.push(
      question({ id: 'q1', experienceId: 'exp_a', category: 'algo', rootCause: 'conceptGap' }),
      question({ id: 'q2', experienceId: 'exp_a', category: 'concept', text: 'Vite 依赖预构建解决什么', rootCause: 'forgot' }),
      question({ id: 'q3', experienceId: 'exp_b', category: 'algo', rootCause: 'nervous' }),
      question({ id: 'q4', experienceId: 'exp_c', category: 'algo', rootCause: 'nervous' }),
      question({ id: 'q5', experienceId: 'exp_c', category: null, text: '反问：团队技术债' }),
    );
    return db;
  }

  it('分类 × 挂：算法类出现在 2/2 场失败面试里', () => {
    const stats = statsByCategory(statsDB());
    const algo = stats.find((stat) => stat.category === 'algo');
    expect(algo?.total).toBe(3);
    expect(algo?.failedAppearances).toBe(2);
    expect(algo?.rate).toBe(1);
  });

  it('未分类单独一档，不硬塞进 6 类', () => {
    const stats = statsByCategory(statsDB());
    const none = stats.find((stat) => stat.category === null);
    expect(none?.label).toBe('未分类');
    expect(none?.total).toBe(1);
  });

  it('公司高频题按题干去重计数', () => {
    const db = statsDB();
    db.questions.push(question({ id: 'q6', experienceId: 'exp_c', category: 'algo', text: '手写 Promise.all' }));
    const stats = statsByCompany(db);
    const bytedance = stats.find((stat) => stat.companyName === '字节跳动');
    expect(bytedance?.items[0].count).toBe(1);
    const meituan = stats.find((stat) => stat.companyName === '美团');
    expect(meituan?.items.some((item) => item.count >= 2)).toBe(true);
  });

  it('rootCause 分布', () => {
    const stats = statsByRootCause(statsDB());
    expect(stats[0].rootCause).toBe('nervous');
    expect(stats[0].count).toBe(2);
    expect(stats.some((stat) => stat.rootCause === null)).toBe(true);
  });

  it('mastery 分布', () => {
    const counts = masteryCounts([
      question({ id: 'a', mastery: 0 }),
      question({ id: 'b', mastery: 0 }),
      question({ id: 'c', mastery: 2 }),
    ]);
    expect(counts).toEqual({ 0: 2, 1: 0, 2: 1 });
  });
});

describe('题目编辑的撤销（T-QB ③）', () => {
  it('只回退被改字段，不碰复习调度（nextReviewAt / reviewCount / updatedAt）', () => {
    const db = emptyDB();
    db.questions = [
      question({
        id: 'q_1',
        text: '改了之后的题干',
        category: 'project',
        mastery: 2,
        myAnswer: '新回答',
        nextReviewAt: '2025-03-20',
        reviewCount: 3,
        updatedAt: '2025-03-13T00:00:00.000Z',
      }),
    ];
    revertQuestionEdit(db, {
      questionId: 'q_1',
      before: { text: '手写 Promise.all', category: 'algo', mastery: 0, myAnswer: undefined },
    });
    const target = db.questions[0];
    expect(target.text).toBe('手写 Promise.all');
    expect(target.category).toBe('algo');
    expect(target.mastery).toBe(0);
    expect(target.myAnswer).toBeUndefined();
    // 调度字段与审计字段不参与回退
    expect(target.nextReviewAt).toBe('2025-03-20');
    expect(target.reviewCount).toBe(3);
    expect(target.updatedAt).toBe('2025-03-13T00:00:00.000Z');
  });

  it('题目已被删掉时静默跳过，不抛错', () => {
    const db = emptyDB();
    expect(() => revertQuestionEdit(db, { questionId: 'gone', before: { text: 'x' } })).not.toThrow();
    expect(db.questions).toHaveLength(0);
  });
});

describe('题目写入口径（T-QB / PRD §20.2 §20.9）', () => {
  /** 注入递增 id，单测里不依赖随机数 */
  function counter(): (prefix: string) => string {
    let n = 0;
    return (prefix: string) => `${prefix}_${(n += 1)}`;
  }

  it('裸字符串入参：默认值与历史落库值逐字节一致（不会 + 未分类 + 难度 2 + 复习 0）', () => {
    const exp = experience({ id: 'exp_1', interviewDate: '2025-03-12' });
    const rows = buildQuestionRows({
      experience: exp,
      items: ['手写 Promise.all'],
      now: NOW,
      makeId: counter(),
    });
    expect(rows).toEqual([
      {
        id: 'q_1',
        experienceId: 'exp_1',
        category: null,
        difficulty: 2,
        text: '手写 Promise.all',
        mastery: 0,
        tags: [],
        nextReviewAt: deriveInitialNextReviewAt('2025-03-12', NOW),
        reviewCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });

  it('对象入参写掌握度与分类；空题干 / 同场重复丢弃；超长题干截断', () => {
    const exp = experience({ id: 'exp_1' });
    const rows = buildQuestionRows({
      experience: exp,
      items: [
        { text: '  事件循环  ', mastery: 2, category: 'concept' },
        { text: '事件循环' }, // 同场重复（大小写与首尾空白无关）
        { text: '   ' }, // 空题干
        { text: '长'.repeat(QUESTION_TEXT_LIMIT + 5) },
      ],
      now: NOW,
      makeId: counter(),
    });
    expect(rows.map((row) => row.text)).toEqual(['事件循环', '长'.repeat(QUESTION_TEXT_LIMIT)]);
    expect(rows[0].mastery).toBe(2);
    expect(rows[0].category).toBe('concept');
    // 后一条没指定 → 回落到默认值
    expect(rows[1].mastery).toBe(0);
    expect(rows[1].category).toBeNull();
  });

  it('applyQuestionEdit：调度三字段就算传进来也写不进去', () => {
    const db = emptyDB();
    db.questions = [
      question({
        id: 'q_1',
        mastery: 0,
        nextReviewAt: '2025-03-20',
        lastReviewedAt: '2025-03-12',
        reviewCount: 3,
      }),
    ];
    applyQuestionEdit(
      db,
      'q_1',
      {
        text: '  改过的题干  ',
        mastery: 2,
        // 下面三个是「我又复习了一遍」才会变的字段，编辑必须丢掉
        reviewCount: 99,
        nextReviewAt: '2030-01-01',
        lastReviewedAt: '2030-01-01',
      },
      NOW,
    );
    const target = db.questions[0];
    expect(target.text).toBe('改过的题干');
    expect(target.mastery).toBe(2);
    expect(target.reviewCount).toBe(3);
    expect(target.nextReviewAt).toBe('2025-03-20');
    expect(target.lastReviewedAt).toBe('2025-03-12');
    expect(target.updatedAt).toBe(NOW);
  });

  it('applyQuestionEdit：答案清空 = 字段整个删掉（与「从没写过」长得一样）', () => {
    const db = emptyDB();
    db.questions = [question({ id: 'q_1', myAnswer: '以前写的' })];
    applyQuestionEdit(db, 'q_1', { myAnswer: '   ', mastery: 1 }, NOW);
    const target = db.questions[0];
    expect('myAnswer' in target).toBe(false);
    expect(target.mastery).toBe(1);
  });

  it('applyQuestionEdit：题目不存在时静默跳过', () => {
    const db = emptyDB();
    expect(() => applyQuestionEdit(db, 'gone', { mastery: 1 }, NOW)).not.toThrow();
    expect(db.questions).toHaveLength(0);
  });

  it('revertQuestionBatch：撤掉这一批题，并只删「这批自己建的空壳」', () => {
    const db = emptyDB();
    db.experiences = [experience({ id: 'exp_new' }), experience({ id: 'exp_old' })];
    db.questions = [
      question({ id: 'q_1', experienceId: 'exp_new' }),
      question({ id: 'q_2', experienceId: 'exp_old' }),
    ];
    revertQuestionBatch(db, { questionIds: ['q_1'], createdExperienceId: 'exp_new' });
    expect(db.questions.map((item) => item.id)).toEqual(['q_2']);
    expect(db.experiences.map((item) => item.id)).toEqual(['exp_old']);
  });

  it('revertQuestionBatch：壳里还有别的题就不删壳；复用已有场次时也不碰它', () => {
    const db = emptyDB();
    db.experiences = [experience({ id: 'exp_1' })];
    db.questions = [
      question({ id: 'q_1', experienceId: 'exp_1' }),
      question({ id: 'q_2', experienceId: 'exp_1' }),
    ];
    // 这批建的壳（虽然理论上不会复用），但里面还有别的题 → 壳留着
    revertQuestionBatch(db, { questionIds: ['q_1'], createdExperienceId: 'exp_1' });
    expect(db.questions.map((item) => item.id)).toEqual(['q_2']);
    expect(db.experiences).toHaveLength(1);
    // 复用已有场次（createdExperienceId = null）→ 壳一定不动
    revertQuestionBatch(db, { questionIds: ['q_2'], createdExperienceId: null });
    expect(db.questions).toHaveLength(0);
    expect(db.experiences).toHaveLength(1);
  });
});

describe('清空语义（显式 undefined = 删掉字段，ExperienceEditor 的「没标 / 删光」依赖它）', () => {
  it('显式 undefined 清掉可空字段；category 不受影响（null 是合法值不是缺键）', () => {
    const db = emptyDB();
    db.questions = [
      question({ id: 'q_1', myAnswer: '旧回答', nextTime: '先说结论', rootCause: 'forgot' }),
    ];
    applyQuestionEdit(db, 'q_1', { myAnswer: undefined, nextTime: undefined, rootCause: undefined }, NOW);
    const target = db.questions[0];
    expect('myAnswer' in target).toBe(false);
    expect('nextTime' in target).toBe(false);
    expect('rootCause' in target).toBe(false);
    // 题干传 undefined 不算清空（题库里不能出现没有题干的题）
    applyQuestionEdit(db, 'q_1', { text: undefined }, NOW);
    expect(target.text).toBe('手写 Promise.all');
  });

  it('patch 里没写到的字段不动（undefined 只在显式写入时才算清空）', () => {
    const db = emptyDB();
    db.questions = [question({ id: 'q_1', myAnswer: '旧回答', mastery: 2 })];
    applyQuestionEdit(db, 'q_1', { mastery: 1 }, NOW);
    expect(db.questions[0].myAnswer).toBe('旧回答');
    expect(db.questions[0].mastery).toBe(1);
  });
});
