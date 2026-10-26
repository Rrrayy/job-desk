/**
 * 旧数据的识别与分组（v0.9.1 / R-RES-9 的纯函数层）。
 *
 * 这一层不做写库（写库一律走 `bindResumeVersion`，架构 B-05），只回答三个问题：
 * 「这条算不算旧数据」「还有几条待归类」「哪些文本看起来是同一个」。
 *
 * 守的是三件容易出错的事：
 * - 空文本不算旧数据（连当时写的什么都没留，问了也答不出该归到哪一版）；
 * - 回收站里的不问（用户已经决定要删了，让它们 30 天后自然消失，别加活）；
 * - 归类完成后自动出列（判据是 `resumeVersionId`，不需要「已处理」标记字段）。
 */

import { describe, expect, it } from 'vitest';
import type { Application, DB } from '../types';
import { emptyDB } from '../lib/defaults';
import { legacyApplicationsOf, legacyCountOf, legacyTextGroupsOf, isLegacy, nextLegacyIndex } from './legacy';

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: overrides.id ?? 'app-1',
    companyId: 'c-1',
    jobTitle: '前端实习',
    status: 'applied',
    statusChangedAt: '2026-02-20T01:00:00.000Z',
    lastActivityAt: '2026-02-20T01:00:00.000Z',
    createdAt: '2026-02-20T01:00:00.000Z',
    updatedAt: '2026-02-20T01:00:00.000Z',
    ...overrides,
  };
}

describe('isLegacy：什么算「旧数据」', () => {
  it('有手输文本、没有 id 绑定 → 旧数据', () => {
    expect(isLegacy(makeApp({ resumeVersion: 'v3-前端-项目版' }))).toBe(true);
  });

  it('绑了 id → 不是（哪怕文本还在）', () => {
    expect(isLegacy(makeApp({ resumeVersionId: 'ver-1', resumeVersion: 'v3' }))).toBe(false);
  });

  it('★ 空文本 / 全空白不算旧数据 —— 问了也答不出该归到哪一版', () => {
    expect(isLegacy(makeApp())).toBe(false);
    expect(isLegacy(makeApp({ resumeVersion: '' }))).toBe(false);
    expect(isLegacy(makeApp({ resumeVersion: '   ' }))).toBe(false);
  });
});

describe('legacyApplicationsOf / legacyCountOf：待归类清单', () => {
  it('只挑旧数据，顺序与录入顺序一致（逐条走的时候顺序要符合直觉）', () => {
    const db: DB = emptyDB();
    db.applications = [
      makeApp({ id: 'a1', resumeVersion: 'v1' }),
      makeApp({ id: 'a2', resumeVersionId: 'ver-1', resumeVersion: 'v2' }),
      makeApp({ id: 'a3', resumeVersion: 'v1' }),
      makeApp({ id: 'a4' }),
    ];
    expect(legacyApplicationsOf(db).map((app) => app.id)).toEqual(['a1', 'a3']);
    expect(legacyCountOf(db)).toBe(2);
  });

  it('★ 回收站里的不问（用户已经决定要删了，归类对统计没有影响）', () => {
    const db: DB = emptyDB();
    db.applications = [
      makeApp({ id: 'a1', resumeVersion: 'v1' }),
      makeApp({ id: 'a2', resumeVersion: 'v2', deletedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    expect(legacyCountOf(db)).toBe(1);
  });

  it('★ 归类完成 → 自动出列（判据是 resumeVersionId，不需要任何「已处理」标记字段）', () => {
    const db: DB = emptyDB();
    const app = makeApp({ resumeVersion: 'v1' });
    db.applications = [app];
    expect(legacyCountOf(db)).toBe(1);

    app.resumeVersionId = 'ver-1';
    app.resumeVersion = 'v1';
    expect(legacyCountOf(db)).toBe(0);
  });

  it('一条都没有时返回 0 / 空数组（横幅据此不渲染）', () => {
    const db: DB = emptyDB();
    expect(legacyCountOf(db)).toBe(0);
    expect(legacyApplicationsOf(db)).toEqual([]);
  });
});

describe('legacyTextGroupsOf：分组只是提示，不是批量入口', () => {
  it('相同文本（首尾空白无关）归成一组，条数多的在前', () => {
    const apps = [
      makeApp({ id: 'a1', resumeVersion: 'v3' }),
      makeApp({ id: 'a2', resumeVersion: '  v3  ' }),
      makeApp({ id: 'a3', resumeVersion: 'v3-前端-项目版' }),
    ];
    expect(legacyTextGroupsOf(apps)).toEqual([
      { text: 'v3', count: 2 },
      { text: 'v3-前端-项目版', count: 1 },
    ]);
  });

  it('★ 大小写不同**不**合并 —— 猜「V3 和 v3 是不是同一份」正是批量归类会错的地方', () => {
    const apps = [makeApp({ id: 'a1', resumeVersion: 'V3' }), makeApp({ id: 'a2', resumeVersion: 'v3' })];
    const groups = legacyTextGroupsOf(apps);
    // 两条各成一组（不合并）；组内顺序按 locale 拼音/大小写规则，不断言（那是展示细节）
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.text).sort()).toEqual(['V3', 'v3']);
    expect(groups.every((group) => group.count === 1)).toBe(true);
  });

  it('空文本不进分组（那条不是旧数据）', () => {
    expect(legacyTextGroupsOf([makeApp(), makeApp({ id: 'a2', resumeVersion: 'v1' })])).toEqual([
      { text: 'v1', count: 1 },
    ]);
  });
});

describe('nextLegacyIndex：走到最后一条之后回到哪', () => {
  it('顺序前进，到末尾回卷（队列长度会因归类而变，调用方按实时长度传）', () => {
    expect(nextLegacyIndex(3, -1)).toBe(0);
    expect(nextLegacyIndex(3, 0)).toBe(1);
    expect(nextLegacyIndex(3, 2)).toBe(0);
    expect(nextLegacyIndex(0, 0)).toBe(-1);
  });
});
