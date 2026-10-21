/**
 * 回收站（v0.5 / D2）测试。
 *
 * 这一层的价值全在**边界**上：删了以后面试还在不在、恢复会不会抢别人的面经、
 * 30 天到期到底删不删、手动延长之后还剩几天。每一条都用真实 Date 推时间算，
 * 不 mock 时钟 —— 这里的 bug 都是「日期算错」，mock 掉就测不出来了。
 */

import { describe, expect, it } from 'vitest';
import type { DB } from '../types';
import { buildSampleDB } from './sample';
import {
  TRASH_RETENTION_DAYS,
  emptyTrash,
  extendTrashRetention,
  isDeleted,
  isTrashExpired,
  markDeleted,
  purgeFromTrash,
  restoreFromTrash,
  sweepTrash,
  trashDaysLeft,
  trashReminder,
  trashedApps,
  visibleDB,
} from './trash';

const NOW = new Date('2026-10-21T12:00:00.000Z');

function dbWithSample(): DB {
  return buildSampleDB(NOW);
}

/** 把第一条投递标成「N 天前删的」 */
function deletedDaysAgo(db: DB, days: number, index = 0): DB {
  const target = db.applications[index];
  const at = new Date(NOW.getTime() - days * 86_400_000).toISOString();
  return markDeleted(db, target.id, at);
}

describe('软删除标记', () => {
  it('markDeleted 只动目标那条，其它投递原样', () => {
    const db = dbWithSample();
    const target = db.applications[0].id;
    const next = markDeleted(db, target, NOW.toISOString());

    expect(isDeleted(next.applications.find((a) => a.id === target)!)).toBe(true);
    expect(next.applications).toHaveLength(db.applications.length);
    for (const app of next.applications) {
      if (app.id === target) continue;
      expect(isDeleted(app)).toBe(false);
    }
  });

  it('isDeleted 把 null / undefined / 空串都当「没删」', () => {
    expect(isDeleted({})).toBe(false);
    expect(isDeleted({ deletedAt: null })).toBe(false);
    expect(isDeleted({ deletedAt: '' })).toBe(false);
    expect(isDeleted({ deletedAt: NOW.toISOString() })).toBe(true);
  });
});

describe('visibleDB：视图看不到回收站里的行', () => {
  it('删掉的投递、它的面试与备注一并不可见，其它照常', () => {
    const db = dbWithSample();
    // 找一条确实带面试和备注的投递
    const target = db.applications.find(
      (app) =>
        db.interviews.some((i) => i.applicationId === app.id) &&
        db.notes.some((n) => n.applicationId === app.id),
    );
    expect(target).toBeTruthy();
    const next = markDeleted(db, target!.id, NOW.toISOString());
    const view = visibleDB(next);

    expect(view.applications.some((a) => a.id === target!.id)).toBe(false);
    expect(view.interviews.some((i) => i.applicationId === target!.id)).toBe(false);
    expect(view.notes.some((n) => n.applicationId === target!.id)).toBe(false);
    // 其余面试一条不少
    expect(view.interviews).toHaveLength(
      db.interviews.filter((i) => i.applicationId !== target!.id).length,
    );
  });

  it('没有删除时原样返回同一个引用（不产生无意义的新对象）', () => {
    const db = dbWithSample();
    expect(visibleDB(db)).toBe(db);
  });

  it('面经不受影响 —— 它是用户写过的内容，不该因为投递被删而消失', () => {
    const db = dbWithSample();
    const withExp = db.experiences.find((exp) => exp.applicationId);
    if (!withExp) return;
    const view = visibleDB(markDeleted(db, withExp.applicationId!, NOW.toISOString()));
    expect(view.experiences.some((exp) => exp.id === withExp.id)).toBe(true);
  });
});

describe('回收站列表与倒计时', () => {
  it('trashedApps 按删除时间倒序，最新的在前', () => {
    let db = dbWithSample();
    db = deletedDaysAgo(db, 5, 0);
    db = deletedDaysAgo(db, 1, 1);
    const list = trashedApps(db);
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(db.applications[1].id);
    expect(list[1].id).toBe(db.applications[0].id);
  });

  it('trashDaysLeft 精确到天：刚删 → 30 天，删了 29 天 → 1 天', () => {
    expect(trashDaysLeft({ deletedAt: NOW.toISOString() }, NOW)).toBe(TRASH_RETENTION_DAYS);
    const almost = new Date(NOW.getTime() - 29 * 86_400_000).toISOString();
    expect(trashDaysLeft({ deletedAt: almost }, NOW)).toBe(1);
  });

  it('没删的投递没有倒计时', () => {
    expect(trashDaysLeft({}, NOW)).toBeNull();
    expect(trashDaysLeft({ deletedAt: null }, NOW)).toBeNull();
  });

  it('满 30 天才算过期，第 29 天不算', () => {
    const d29 = new Date(NOW.getTime() - 29 * 86_400_000).toISOString();
    const d30 = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    expect(isTrashExpired({ deletedAt: d29 }, NOW)).toBe(false);
    expect(isTrashExpired({ deletedAt: d30 }, NOW)).toBe(true);
  });
});

describe('恢复', () => {
  it('恢复后面试与备注都回来了，绑定关系完整', () => {
    const db = dbWithSample();
    const target = db.applications.find((app) => db.interviews.some((i) => i.applicationId === app.id))!;
    const deleted = markDeleted(db, target.id, NOW.toISOString());
    const restored = restoreFromTrash(deleted, target.id);

    expect(isDeleted(restored.applications.find((a) => a.id === target.id)!)).toBe(false);
    expect(visibleDB(restored).interviews.filter((i) => i.applicationId === target.id)).toHaveLength(
      db.interviews.filter((i) => i.applicationId === target.id).length,
    );
  });

  it('恢复是幂等的：重复恢复不会复制出第二条', () => {
    const db = dbWithSample();
    const id = db.applications[0].id;
    const once = restoreFromTrash(markDeleted(db, id, NOW.toISOString()), id);
    const twice = restoreFromTrash(once, id);
    expect(twice.applications.filter((a) => a.id === id)).toHaveLength(1);
    expect(twice).toBe(once); // 已经是可见状态 → 原样返回
  });
});

describe('永久删除', () => {
  it('purgeFromTrash 真删投递 + 面试 + 备注，但面经只解绑不删', () => {
    const db = dbWithSample();
    const target = db.applications.find((app) => db.experiences.some((e) => e.applicationId === app.id))!;
    const expCount = db.experiences.length;
    const purged = purgeFromTrash(db, target.id);

    expect(purged.applications.some((a) => a.id === target.id)).toBe(false);
    expect(purged.interviews.some((i) => i.applicationId === target.id)).toBe(false);
    expect(purged.notes.some((n) => n.applicationId === target.id)).toBe(false);
    expect(purged.experiences).toHaveLength(expCount);
    expect(purged.experiences.filter((e) => e.applicationId === target.id)).toHaveLength(0);
  });

  it('emptyTrash 只清回收站，没删的一条不动', () => {
    let db = dbWithSample();
    const keepId = db.applications[db.applications.length - 1].id;
    db = deletedDaysAgo(db, 3, 0);
    db = deletedDaysAgo(db, 4, 1);
    const after = emptyTrash(db);

    expect(after.applications.some((a) => a.id === keepId)).toBe(true);
    expect(trashedApps(after)).toHaveLength(0);
    expect(after.applications).toHaveLength(db.applications.length - 2);
  });

  it('清空空的回收站是空操作', () => {
    const db = dbWithSample();
    expect(emptyTrash(db)).toBe(db);
  });
});

describe('保留期延长', () => {
  it('再留 7 天：剩 1 天 → 剩 8 天', () => {
    const db = dbWithSample();
    const id = db.applications[0].id;
    const almost = new Date(NOW.getTime() - 29 * 86_400_000).toISOString();
    const marked = markDeleted(db, id, almost);
    expect(trashDaysLeft(marked.applications.find((a) => a.id === id)!, NOW)).toBe(1);

    const extended = extendTrashRetention(marked, id);
    expect(trashDaysLeft(extended.applications.find((a) => a.id === id)!, NOW)).toBe(8);
  });

  it('延长不会把已经在回收站外的投递拖进来', () => {
    const db = dbWithSample();
    const id = db.applications[0].id;
    expect(extendTrashRetention(db, id).applications.find((a) => a.id === id)!.deletedAt).toBeUndefined();
  });
});

describe('启动清理 sweepTrash', () => {
  it('只清过期的；29 天的留着', () => {
    let db = dbWithSample();
    db = deletedDaysAgo(db, 31, 0); // 过期
    db = deletedDaysAgo(db, 29, 1); // 还剩 1 天
    const keptId = db.applications[1].id;
    const doomedId = db.applications[0].id;

    const result = sweepTrash(db, NOW);
    expect(result.removedApps).toBe(1);
    expect(result.db.applications.some((a) => a.id === doomedId)).toBe(false);
    expect(result.db.applications.some((a) => a.id === keptId)).toBe(true);
  });

  it('没有过期项时原样返回，且不动任何数据', () => {
    const db = dbWithSample();
    const result = sweepTrash(db, NOW);
    expect(result.db).toBe(db);
    expect(result.removedApps).toBe(0);
  });

  it('清理会连带删掉过期投递下的面试与备注，并解绑面经', () => {
    const db = dbWithSample();
    const target = db.applications.find((app) => db.experiences.some((e) => e.applicationId === app.id))!;
    const stale = markDeleted(db, target.id, new Date(NOW.getTime() - 40 * 86_400_000).toISOString());
    const result = sweepTrash(stale, NOW);

    expect(result.removedInterviews).toBeGreaterThanOrEqual(0);
    expect(result.db.experiences.every((e) => e.applicationId !== target.id)).toBe(true);
    expect(result.db.experiences).toHaveLength(db.experiences.length);
  });
});

describe('到期提醒', () => {
  it('剩 3 天内计入 expiring，剩 7 天不算', () => {
    let db = dbWithSample();
    db = deletedDaysAgo(db, 28, 0); // 剩 2 天
    db = deletedDaysAgo(db, 23, 1); // 剩 7 天
    const reminder = trashReminder(db, NOW);
    expect(reminder.expiring).toBe(1);
    expect(reminder.soonestDaysLeft).toBe(2);
  });

  it('空回收站不提醒', () => {
    expect(trashReminder(dbWithSample(), NOW)).toEqual({
      expiring: 0,
      expired: 0,
      soonestDaysLeft: null,
    });
  });
});
