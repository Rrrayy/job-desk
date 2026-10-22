/**
 * AISuggestion 生命周期单测（v0.8 / T03，ARCH §1.5）。
 *
 * 覆盖：提案 → pending → 勾选接受（staging 字段写回 / 新建 note / 新建 question）
 * → ⌘Z 整体回退（revertAi 只恢复本次确认写入的差异，用户手写行不受影响）
 * → reject → 7 天 sweep。
 */

import { describe, expect, it } from 'vitest';
import {
  SUGGESTION_RETENTION_DAYS,
  applySuggestions,
  createSuggestions,
  rejectSuggestions,
  revertAi,
  sweepExpiredSuggestions,
} from './suggestions';
import type { NewAISuggestion } from './types';
import { emptyDB } from '../lib/defaults';
import type { AISuggestion, DB } from '../types';

const NOW = '2026-10-21T10:00:00.000Z';

function dbWithStaging(): DB {
  const db = emptyDB();
  db.staging = [
    {
      id: 'st-1',
      platform: 'custom',
      reason: 'unparsed',
      parsed: {
        platform: 'custom',
        companyName: '',
        jobTitle: '',
        statusRaw: '',
        capturedAt: NOW,
        fields: {},
      } as unknown as DB['staging'][number]['parsed'],
      rawSnippet: '字节 前端 25k',
      capturedAt: NOW,
    },
  ];
  return db;
}

function stagingSuggestion(): NewAISuggestion {
  return {
    pluginId: 'builtin:d17',
    targetType: 'staging_field',
    targetId: 'st-1',
    fieldPath: 'companyName',
    content: '字节跳动',
    evidence: '字节 前端 25k',
  };
}

function parsedOf(db: DB): Record<string, unknown> {
  return db.staging[0].parsed as unknown as Record<string, unknown>;
}

describe('suggestions · 提案', () => {
  it('createSuggestions 补 id / pending / createdAt，evidence 按输入保留', () => {
    const list = createSuggestions([stagingSuggestion()], NOW);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      pluginId: 'builtin:d17',
      targetType: 'staging_field',
      targetId: 'st-1',
      fieldPath: 'companyName',
      content: '字节跳动',
      status: 'pending',
      createdAt: NOW,
    });
    expect(list[0].id).toMatch(/^sugg_/);
    expect(list[0].evidence).toBe('字节 前端 25k');
  });
});

describe('suggestions · 接受（单次遍历写目标 + 撤销快照）', () => {
  it('staging_field：写回 parsed.companyName，undo 记旧值', () => {
    const db = dbWithStaging();
    const [sugg] = createSuggestions([stagingSuggestion()], NOW);
    db.aiSuggestions = [sugg];

    const { undo, applied } = applySuggestions(db, new Set([sugg.id]), { nowIso: NOW });
    expect(applied).toBe(1);
    expect(parsedOf(db).companyName).toBe('字节跳动');
    expect(db.aiSuggestions[0].status).toBe('accepted');
    expect(undo.suggestions[0].status).toBe('pending');
    expect(undo.targets[0]).toMatchObject({
      table: 'staging',
      id: 'st-1',
      field: 'companyName',
      prevValue: '',
      rowExisted: true,
    });
  });

  it('staging_field revert：字段回旧值（原来没有该字段 → 删键），建议回 pending', () => {
    const db = dbWithStaging();
    const [sugg] = createSuggestions([{ ...stagingSuggestion(), fieldPath: 'salaryText' }], NOW);
    db.aiSuggestions = [sugg];
    const { undo } = applySuggestions(db, new Set([sugg.id]), { nowIso: NOW });
    expect(parsedOf(db).salaryText).toBe('字节跳动');

    revertAi(db, undo);
    expect(parsedOf(db).salaryText).toBeUndefined();
    expect(db.aiSuggestions[0].status).toBe('pending');
    expect(db.aiSuggestions[0].decidedAt).toBeUndefined();
  });

  it('application_note：新建 memo note 行；revert 整行移除，不伤及用户手写行', () => {
    const db = emptyDB();
    db.applications = [
      {
        id: 'app-1',
        companyId: 'c-1',
        jobTitle: '前端',
        status: 'chatting',
        statusChangedAt: NOW,
        lastActivityAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    db.notes = [
      // 用户手写的既有行 —— ⌘Z 之后必须原样还在（共享知识 #7）
      { id: 'n-user', applicationId: 'app-1', type: 'memo', content: '我自己的笔记', touchedAt: NOW },
    ];
    const [sugg] = createSuggestions(
      [{ pluginId: 'builtin:d15', targetType: 'application_note', targetId: 'app-1', fieldPath: 'content', content: '您好，想跟进一下进度' }],
      NOW,
    );
    db.aiSuggestions = [sugg];
    const { undo } = applySuggestions(db, new Set([sugg.id]), { nowIso: NOW });
    expect(db.notes).toHaveLength(2);
    expect(db.notes[1]).toMatchObject({ applicationId: 'app-1', type: 'memo', content: '您好，想跟进一下进度' });

    revertAi(db, undo);
    expect(db.notes).toHaveLength(1);
    expect(db.notes[0]).toMatchObject({ id: 'n-user', content: '我自己的笔记' });
    expect(db.aiSuggestions[0].status).toBe('pending');
    expect(db.aiSuggestions[0].decidedAt).toBeUndefined();
  });

  it('question（targetId=null）：经 resolveQuestionExperienceId 新建 Question；revert 移除', () => {
    const db = emptyDB();
    const [sugg] = createSuggestions(
      [{ pluginId: 'builtin:d14', targetType: 'question', targetId: null, fieldPath: 'text', content: '介绍一下 React fiber' }],
      NOW,
    );
    db.aiSuggestions = [sugg];
    const { undo, applied } = applySuggestions(db, new Set([sugg.id]), {
      nowIso: NOW,
      resolveQuestionExperienceId: () => 'exp-1',
    });
    expect(applied).toBe(1);
    expect(db.questions).toHaveLength(1);
    expect(db.questions[0]).toMatchObject({ experienceId: 'exp-1', text: '介绍一下 React fiber', mastery: 0 });

    revertAi(db, undo);
    expect(db.questions).toHaveLength(0);
    expect(db.aiSuggestions[0].status).toBe('pending');
  });

  it('不在 ids 里的建议一动不动', () => {
    const db = dbWithStaging();
    const [a, b] = createSuggestions([stagingSuggestion(), stagingSuggestion()], NOW);
    b.targetId = 'st-1';
    b.fieldPath = 'jobTitle';
    db.aiSuggestions = [a, b];
    applySuggestions(db, new Set([a.id]), { nowIso: NOW });
    expect(db.aiSuggestions[1].status).toBe('pending');
    expect(parsedOf(db).jobTitle).toBe('');
  });

  it('目标行已消失（staging 被清空）：建议翻 accepted、不写库，revert 不炸', () => {
    const db = dbWithStaging();
    const [sugg] = createSuggestions([stagingSuggestion()], NOW);
    db.aiSuggestions = [sugg];
    db.staging = [];
    const { undo, applied } = applySuggestions(db, new Set([sugg.id]), { nowIso: NOW });
    expect(applied).toBe(0);
    expect(db.aiSuggestions[0].status).toBe('accepted');
    expect(undo.targets).toHaveLength(0);
    revertAi(db, undo); // 不抛错即可
    expect(db.aiSuggestions[0].status).toBe('pending');
  });

  it('D17：补出公司名后 reason 从 unparsed 放开为 unmapped（否则用户无法归位）', () => {
    const db = dbWithStaging();
    const [sugg] = createSuggestions([stagingSuggestion()], NOW);
    db.aiSuggestions = [sugg];
    expect(db.staging[0].reason).toBe('unparsed');

    const { undo } = applySuggestions(db, new Set([sugg.id]), { nowIso: NOW });
    expect(db.staging[0].reason).toBe('unmapped');
    expect(undo.targets[0].prevReason).toBe('unparsed');

    // ⌘Z 之后暂存区回到「没解析出来」，与内容一起还原（不留半真半假的中间态）
    revertAi(db, undo);
    expect(db.staging[0].reason).toBe('unparsed');
    expect(parsedOf(db).companyName).toBe('');
  });

  it('D17：只补了岗位名 / 没补出公司名时，reason 保持 unparsed', () => {
    const db = dbWithStaging();
    const [sugg] = createSuggestions([{ ...stagingSuggestion(), fieldPath: 'jobTitle', content: '前端实习生' }], NOW);
    db.aiSuggestions = [sugg];
    const { undo } = applySuggestions(db, new Set([sugg.id]), { nowIso: NOW });
    expect(db.staging[0].reason).toBe('unparsed');
    expect(undo.targets[0].prevReason).toBeUndefined();
  });

  it('验收 10：三题只勾两题 → 库内恰好 +2；⌘Z 整体回退到 0', () => {
    const db = emptyDB();
    const list = createSuggestions(
      [
        { pluginId: 'builtin:d14', targetType: 'question', targetId: null, fieldPath: 'text', content: 'Vue 响应式原理' },
        { pluginId: 'builtin:d14', targetType: 'question', targetId: null, fieldPath: 'text', content: '手写防抖' },
        { pluginId: 'builtin:d14', targetType: 'question', targetId: null, fieldPath: 'text', content: '反问环节' },
      ],
      NOW,
    );
    db.aiSuggestions = list;
    const picked = new Set([list[0].id, list[2].id]);

    const { undo, applied } = applySuggestions(db, picked, {
      nowIso: NOW,
      resolveQuestionExperienceId: () => 'exp-1',
    });
    expect(applied).toBe(2);
    expect(db.questions).toHaveLength(2);
    expect(db.questions.map((question) => question.text)).toEqual(['Vue 响应式原理', '反问环节']);
    // 没勾的那条仍是 pending（用户随时可以回头再收）
    expect(db.aiSuggestions[1].status).toBe('pending');

    revertAi(db, undo);
    expect(db.questions).toHaveLength(0);
    expect(db.aiSuggestions.map((suggestion) => suggestion.status)).toEqual(['pending', 'pending', 'pending']);
  });
});

describe('suggestions · 拒绝', () => {
  it('rejectSuggestions 翻状态 + decidedAt，不写目标表', () => {
    const db = dbWithStaging();
    const [sugg] = createSuggestions([stagingSuggestion()], NOW);
    db.aiSuggestions = [sugg];
    const count = rejectSuggestions(db, new Set([sugg.id]), NOW);
    expect(count).toBe(1);
    expect(db.aiSuggestions[0].status).toBe('rejected');
    expect(db.aiSuggestions[0].decidedAt).toBe(NOW);
    expect(parsedOf(db).companyName).toBe('');
  });
});

describe('suggestions · 7 天清理', () => {
  const DAY = 86_400_000;

  it(`超期 ${SUGGESTION_RETENTION_DAYS} 天的 accepted/rejected 被清，pending 永不清`, () => {
    const now = new Date('2026-10-21T10:00:00.000Z');
    const base = createSuggestions([stagingSuggestion()], NOW);
    const oldAccepted: AISuggestion = {
      ...base[0],
      id: 's-a',
      status: 'accepted',
      decidedAt: new Date(now.getTime() - 8 * DAY).toISOString(),
    };
    const oldRejected: AISuggestion = {
      ...base[0],
      id: 's-r',
      status: 'rejected',
      decidedAt: new Date(now.getTime() - 7.5 * DAY).toISOString(),
    };
    const freshRejected: AISuggestion = {
      ...base[0],
      id: 's-f',
      status: 'rejected',
      decidedAt: new Date(now.getTime() - 2 * DAY).toISOString(),
    };
    const pending: AISuggestion = {
      ...base[0],
      id: 's-p',
      status: 'pending',
      createdAt: new Date(now.getTime() - 30 * DAY).toISOString(),
    };

    const result = sweepExpiredSuggestions([oldAccepted, oldRejected, freshRejected, pending], now);
    expect(result.removed).toBe(2);
    expect(result.kept.map((item) => item.id)).toEqual(['s-f', 's-p']);
  });

  it('decidedAt 缺失时按 createdAt 兜底；时间非法按「不过期」处理', () => {
    const now = new Date('2026-10-21T10:00:00.000Z');
    const base = createSuggestions([stagingSuggestion()], NOW);
    const oldNoDecided: AISuggestion = {
      ...base[0],
      id: 's-1',
      status: 'accepted',
      createdAt: new Date(now.getTime() - 9 * DAY).toISOString(),
    };
    const broken: AISuggestion = { ...base[0], id: 's-2', status: 'rejected', createdAt: 'not-a-date' };

    const result = sweepExpiredSuggestions([oldNoDecided, broken], now);
    expect(result.removed).toBe(1);
    expect(result.kept.map((item) => item.id)).toEqual(['s-2']);
  });
});
