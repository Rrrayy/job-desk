import { describe, expect, it } from 'vitest';
import type { DB, Interview, InterviewExperience, Question } from '../types';
import { emptyDB } from './defaults';
import {
  bumpMastery,
  deriveInitialNextReviewAt,
  isDue,
  masteryCounts,
  nextReviewAtFor,
  pendingReviewInterviews,
  reviewQueue,
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
