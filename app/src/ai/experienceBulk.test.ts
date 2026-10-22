/**
 * R-AI-11 面经整段极速录入（v0.9 / T07b）—— ARCH 验收 ⑨–⑮ 的单测层。
 *
 * 守的口径：
 * - 编号与分类**不听模型的**（ref 根本不读、非法 category 落 null）；
 * - 不吞原文（unmatched 带前缀写 overallNote，不写成题目）；
 * - 超限不静默（50 题之外 truncated 计数）；
 * - 一次采用 = 一次 mutate：1 experience + N question + order 1..N，
 *   ⌘Z 一次全回滚（experiences/questions 与操作前 JSON 等价）；
 * - 补录路径不新建壳，⌘Z 只移除题目 + 还原 overallNote 原值；
 * - 出境等式：user 消息 === checked.note。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyBulkAdoption, bulkItemsToSuggestions, parseBulkOutput } from './experienceBulk';
import { buildScenarioMessages, scenarioPreviewFields } from './scenarios';
import { createSuggestions, revertAi } from './suggestions';
import type { NewAISuggestion } from './types';
import { emptyDB } from '../lib/defaults';
import type { DB } from '../types';

const NOW = '2026-10-22T10:00:00.000Z';

function bulkSuggestions(texts: string[]): NewAISuggestion[] {
  return bulkItemsToSuggestions('builtin:d14-bulk', texts.map((text) => ({ text, category: null })));
}

function dbWithSuggestions(texts: string[]): DB {
  const db = emptyDB();
  db.aiSuggestions = createSuggestions(bulkSuggestions(texts), NOW);
  return db;
}

const SNAPSHOT = (db: DB): string =>
  JSON.stringify({ experiences: db.experiences, questions: db.questions });

describe('experienceBulk · parseBulkOutput（八条窄校验）', () => {
  it('验收 27：编号与分类不听模型的 —— ref 被忽略、非法 category 落 null', () => {
    const raw = JSON.stringify({
      questions: [
        { ref: 7, text: '第一题', category: '算法' },
        { ref: 7, text: '第二题' },
      ],
    });
    const result = parseBulkOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.items.map((item) => item.text)).toEqual(['第一题', '第二题']);
    expect(result.parsed.items[0].category).toBeNull(); // 「算法」不在枚举 → null，绝不落非法值
  });

  it('同批次重复题干（大小写不敏感）只留一条', () => {
    const result = parseBulkOutput(
      JSON.stringify({ questions: [{ text: 'Vue 响应式' }, { text: 'vue 响应式' }] }),
    );
    expect(result.ok && result.parsed.items).toHaveLength(1);
  });

  it('验收 28：51 题 → 只入预览 50 + truncated=1，不静默', () => {
    const questions = Array.from({ length: 51 }, (_, index) => ({ text: `题 ${index + 1}` }));
    const result = parseBulkOutput(JSON.stringify({ questions }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.items).toHaveLength(50);
    expect(result.parsed.truncated).toBe(1);
  });

  it('0 题 → 诚实报错（ok:false），不假装成功', () => {
    expect(parseBulkOutput(JSON.stringify({ questions: [] })).ok).toBe(false);
    // 单行废话不进兜底 —— 变出一道假题比报错严重（验收 28）
    expect(parseBulkOutput('模型胡说的没有 JSON 也没有题').ok).toBe(false);
  });

  it('不吞原文：unmatched 原样保留；超 20 段丢弃并计入 truncated', () => {
    const segments = Array.from({ length: 22 }, (_, index) => `补充段落 ${index + 1}`);
    const result = parseBulkOutput(
      JSON.stringify({ questions: [{ text: '唯一一题' }], unmatched: segments }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.unmatched).toHaveLength(20);
    expect(result.parsed.unmatched[0]).toBe('补充段落 1');
    expect(result.parsed.truncated).toBe(2);
  });

  it('head 只做窄校验后的建议：字段类型不对就不带', () => {
    const result = parseBulkOutput(
      JSON.stringify({
        questions: [{ text: '题' }],
        head: { companyName: ' 字节 ', jobTitle: 42, round: '两' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.head).toEqual({ companyName: '字节', round: null }); // jobTitle 非字符串丢弃
  });

  it('questions 非数组 → 多行「一行一题」兜底仍可用', () => {
    const result = parseBulkOutput('1. 手写防抖\n2. 事件循环');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.items.map((item) => item.text)).toEqual(['手写防抖', '事件循环']);
  });
});

describe('experienceBulk · 出境口径（验收 29）', () => {
  it('默认勾选只有 note：user 消息 === checked.note（等式，不是承诺）', () => {
    const messages = buildScenarioMessages('d14-bulk', { note: '整段原文' });
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('整段原文');
  });

  it('companyName/jobTitle 是显式勾选的例外：勾了才以「标签：值」追加', () => {
    const messages = buildScenarioMessages('d14-bulk', { note: '整段原文', companyName: '字节' });
    expect(messages[1].content).toBe('整段原文\n公司名：字节');
    // 不勾就一个字符都不出现（D13 铁律）
    const messages2 = buildScenarioMessages('d14-bulk', { note: '整段原文', companyName: '' });
    expect(messages2[1].content).toBe('整段原文');
  });

  it('出境字段集合 ⊆ {note, companyName, jobTitle}，note 锁定、companyName 默认不勾', () => {
    const spec = scenarioPreviewFields('d14-bulk', {});
    expect(new Set(spec.map((field) => field.name))).toEqual(
      new Set(['note', 'companyName', 'jobTitle']),
    );
    expect(spec.find((field) => field.name === 'note')?.locked).toBe(true);
    expect(spec.find((field) => field.name === 'companyName')?.defaultChecked).toBe(false);
  });
});

describe('experienceBulk · applyBulkAdoption（一次 mutate）', () => {
  it('验收 25 主路径：全部采用 → 1 experience + N questions + order 1..N → ⌘Z 全回滚', () => {
    const db = dbWithSuggestions(['缓存设计', 'Promise.all', '事件循环']);
    const before = SNAPSHOT(db);
    const result = applyBulkAdoption(
      db,
      {
        head: { companyName: '字节跳动', jobTitle: '前端', interviewDate: '2026-10-20', round: 2 },
        suggestionIds: db.aiSuggestions.map((item) => item.id),
        unmatchedKeep: ['反问环节聊了团队分工'],
        unmatchedDropped: 0,
      },
      { nowIso: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(db.experiences).toHaveLength(1);
    expect(db.experiences[0].companyName).toBe('字节跳动');
    expect(db.questions).toHaveLength(3);
    expect(db.questions.map((item) => item.order)).toEqual([1, 2, 3]);
    expect(db.questions.every((item) => item.experienceId === result.experienceId)).toBe(true);
    expect(db.experiences[0].overallNote).toBe(
      `// 未识别为题目的原文\n反问环节聊了团队分工`,
    );

    // ⌘Z 一次全回滚：experiences/questions 与操作前 JSON 等价
    revertAi(db, result.undo);
    expect(SNAPSHOT(db)).toBe(before);
  });

  it('验收 30 补录路径：existingExperienceId 不新建壳；⌘Z 只移除题目 + 还原 overallNote', () => {
    const db = dbWithSuggestions(['手写防抖']);
    db.experiences.push({
      id: 'exp_exist',
      applicationId: null,
      companyName: '美团',
      interviewDate: '2026-10-19',
      result: 'pending',
      source: 'self',
      overallNote: '原有感受',
      createdAt: NOW,
      updatedAt: NOW,
    } as DB['experiences'][number]);
    const experienceBefore = JSON.stringify(db.experiences);

    const result = applyBulkAdoption(
      db,
      {
        head: { companyName: '美团', interviewDate: '2026-10-19' },
        suggestionIds: db.aiSuggestions.map((item) => item.id),
        unmatchedKeep: ['新补充的一段'],
        unmatchedDropped: 0,
        existingExperienceId: 'exp_exist',
      },
      { nowIso: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(db.experiences).toHaveLength(1); // 没有新建第二种壳
    expect(db.experiences[0].id).toBe('exp_exist');
    expect(db.questions).toHaveLength(1);
    expect(db.experiences[0].overallNote).toBe('原有感受\n\n// 未识别为题目的原文\n新补充的一段');

    revertAi(db, result.undo);
    expect(JSON.stringify(db.experiences)).toBe(experienceBefore); // overallNote 原值还原
    expect(db.questions).toHaveLength(0); // 题目整行移除
  });

  it('前置校验全在写入之前：没公司名 / 没勾题 / 全部已处理 → 零写入', () => {
    const db = dbWithSuggestions(['题']);
    const before = SNAPSHOT(db);
    expect(
      applyBulkAdoption(db, { head: { companyName: ' ', interviewDate: NOW }, suggestionIds: ['sugg_x'], unmatchedKeep: [], unmatchedDropped: 0 }, { nowIso: NOW }).ok,
    ).toBe(false);
    expect(
      applyBulkAdoption(db, { head: { companyName: '字节', interviewDate: NOW }, suggestionIds: [], unmatchedKeep: [], unmatchedDropped: 0 }, { nowIso: NOW }).ok,
    ).toBe(false);
    expect(
      applyBulkAdoption(db, { head: { companyName: '字节', interviewDate: NOW }, suggestionIds: ['sugg_missing'], unmatchedKeep: [], unmatchedDropped: 0 }, { nowIso: NOW }).ok,
    ).toBe(false);
    expect(SNAPSHOT(db)).toBe(before);
  });
});

describe('experienceBulk · 建议形状与入口唯一（验收 30）', () => {
  it('bulkItemsToSuggestions：meta 带 category/myAnswer，targetId 恒 null', () => {
    const list = bulkItemsToSuggestions('builtin:d14-bulk', [
      { text: '题 A', category: 'algo' },
      { text: '题 B', category: null, myAnswer: '答了' },
      { text: '题 C', category: null },
    ]);
    expect(list[0]).toMatchObject({ pluginId: 'builtin:d14-bulk', targetType: 'question', targetId: null, content: '题 A', meta: { category: 'algo' } });
    expect(list[1].meta).toEqual({ myAnswer: '答了' });
    expect(list[2].meta).toBeUndefined();
  });

  it('全仓 ExperienceEditor 只有一处实现（第二个面经编辑器是禁手）', () => {
    const dir = join(__dirname, '..', 'components', 'interview');
    const defining = readdirSync(dir).filter((name) => {
      if (!name.endsWith('.tsx') || name.endsWith('.test.tsx')) return false;
      return readFileSync(join(dir, name), 'utf8').includes('export function ExperienceEditor');
    });
    expect(defining).toEqual(['ExperienceEditor.tsx']);
  });
});
