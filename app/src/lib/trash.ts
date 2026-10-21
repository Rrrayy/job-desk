/**
 * 回收站（v0.5）：软删除、视图过滤、留期清理。
 *
 * 设计要点（后续不可破坏）：
 *
 * 1. **删除 = 打标记，不是抹掉**。`Application.deletedAt` 有值即在回收站里。
 *    面试 / 备注 / 面经不单独打标记 —— 它们的可见性由父投递推导。
 *    为什么：单独打标记就会出现「投递恢复了、面试没恢复」这种半残状态，
 *    而且两套标记必然漂移。宁可让读取侧多走一次 `isAppHidden()`。
 *
 * 2. **过滤只有一处**：App 构造 `api.db` 时把回收站里的行摘掉。
 *    绝不要求每个组件自己判 —— 40+ 个消费点，漏一个就是「删了还看得见」，
 *    而这种 bug 在界面上表现为「数据错乱」，比崩溃更难查。
 *
 * 3. **留期 30 天，第 27 天提醒一次**。清理发生在启动时（`sweepTrash`），
 *    而不是定时器 —— 没人希望一个求职工具在后台悄悄删东西，
 *    用户下次打开时看到「已清理 N 条」比后台静默删除诚实得多。
 */

import type { DB } from '../types';

/** 回收站保留天数 */
export const TRASH_RETENTION_DAYS = 30;
/** 到期前几天开始提醒（第 27 天） */
export const TRASH_REMIND_BEFORE_DAYS = 3;
/** 手动「再留 7 天」一次延长多少天 */
export const TRASH_EXTEND_DAYS = 7;

const DAY_MS = 86_400_000;

/** 一条投递是否在回收站里 */
export function isDeleted(app: { deletedAt?: string | null }): boolean {
  return typeof app.deletedAt === 'string' && app.deletedAt.length > 0;
}

/** 进入回收站的时间戳（毫秒）；没进回收站或时间戳非法返回 null */
export function deletedAtMs(app: { deletedAt?: string | null }): number | null {
  if (!isDeleted(app)) return null;
  const ms = Date.parse(app.deletedAt as string);
  return Number.isNaN(ms) ? null : ms;
}

/** 距离「到期自动清除」还剩几天（向上取整）；不在回收站返回 null */
export function trashDaysLeft(app: { deletedAt?: string | null }, now: Date): number | null {
  const ms = deletedAtMs(app);
  if (ms === null) return null;
  const left = ms + TRASH_RETENTION_DAYS * DAY_MS - now.getTime();
  return Math.ceil(left / DAY_MS);
}

/** 是否已经过了保留期（该真删了） */
export function isTrashExpired(app: { deletedAt?: string | null }, now: Date): boolean {
  const ms = deletedAtMs(app);
  if (ms === null) return false;
  return ms + TRASH_RETENTION_DAYS * DAY_MS <= now.getTime();
}

/**
 * 生成「给视图看」的库：摘掉回收站里的投递，以及挂在它们下面的面试 / 备注。
 *
 * 注意这里是**浅拷贝 + 新数组**，不做深拷贝：整体深拷贝一份 200 条的库
 * 每次渲染都跑一遍，成本比省下来的可读性值钱。数组换了引用就够 React 认出来。
 */
export function visibleDB(db: DB): DB {
  let hasDeleted = false;
  for (const app of db.applications) {
    if (isDeleted(app)) {
      hasDeleted = true;
      break;
    }
  }
  if (!hasDeleted) return db;

  const hiddenIds = new Set<string>();
  const applications = [];
  for (const app of db.applications) {
    if (isDeleted(app)) hiddenIds.add(app.id);
    else applications.push(app);
  }
  return {
    ...db,
    applications,
    interviews: db.interviews.filter((item) => !hiddenIds.has(item.applicationId)),
    notes: db.notes.filter((item) => !hiddenIds.has(item.applicationId)),
  };
}

/** 回收站里的投递，按「删得最晚的在前」排 */
export function trashedApps(db: DB): DB['applications'] {
  return db.applications
    .filter((app) => isDeleted(app))
    .sort((a, b) => (deletedAtMs(b) ?? 0) - (deletedAtMs(a) ?? 0));
}

export interface TrashReminder {
  /** 即将到期（剩余 ≤ 3 天但还没过期）的条数 */
  expiring: number;
  /** 已过期但还没被清理的条数（理论上启动时就被清了，留作兜底提示） */
  expired: number;
  /** 其中最早到期的还剩几天 */
  soonestDaysLeft: number | null;
}

/** 设置页 / 启动时用：算一下要不要提醒 */
export function trashReminder(db: DB, now: Date): TrashReminder {
  let expiring = 0;
  let expired = 0;
  let soonestDaysLeft: number | null = null;
  for (const app of db.applications) {
    if (!isDeleted(app)) continue;
    const days = trashDaysLeft(app, now);
    if (days === null) continue;
    if (days <= 0) {
      expired += 1;
      continue;
    }
    if (days <= TRASH_REMIND_BEFORE_DAYS) {
      expiring += 1;
      soonestDaysLeft = soonestDaysLeft === null ? days : Math.min(soonestDaysLeft, days);
    }
  }
  return { expiring, expired, soonestDaysLeft };
}

export interface SweepResult {
  db: DB;
  /** 被真删掉的投递条数 */
  removedApps: number;
  /** 连带删掉的面试 / 备注 / 面经解绑条数 */
  removedInterviews: number;
  removedNotes: number;
}

/**
 * 启动时清理过期项：只处理真的超过 30 天的，且**永不碰**没进回收站的行。
 * 过期投递下的面试与备注一并真删；面经不删（它是用户写的内容），只解绑。
 */
export function sweepTrash(db: DB, now: Date): SweepResult {
  const doomed = new Set<string>();
  for (const app of db.applications) {
    if (isTrashExpired(app, now)) doomed.add(app.id);
  }
  if (doomed.size === 0) {
    return { db, removedApps: 0, removedInterviews: 0, removedNotes: 0 };
  }

  const interviews = db.interviews.filter((item) => !doomed.has(item.applicationId));
  const notes = db.notes.filter((item) => !doomed.has(item.applicationId));
  return {
    db: {
      ...db,
      applications: db.applications.filter((app) => !doomed.has(app.id)),
      interviews,
      notes,
      experiences: db.experiences.map((exp) =>
        exp.applicationId && doomed.has(exp.applicationId) ? { ...exp, applicationId: null } : exp,
      ),
    },
    removedApps: doomed.size,
    removedInterviews: db.interviews.length - interviews.length,
    removedNotes: db.notes.length - notes.length,
  };
}

/** 把一条投递放进回收站（不改其他行；面试/备注靠父投递标记变不可见） */
export function markDeleted(db: DB, appId: string, nowIso: string): DB {
  return {
    ...db,
    applications: db.applications.map((app) => (app.id === appId ? { ...app, deletedAt: nowIso } : app)),
  };
}

/** 从回收站恢复。已经是可见状态时原样返回（幂等） */
export function restoreFromTrash(db: DB, appId: string): DB {
  const target = db.applications.find((app) => app.id === appId);
  if (!target || !isDeleted(target)) return db;
  return {
    ...db,
    applications: db.applications.map((app) => (app.id === appId ? { ...app, deletedAt: null } : app)),
  };
}

/**
 * 永久删除一条：真删投递 + 它的面试 + 备注；面经解绑保留。
 * 与 sweepTrash 的区别只是「不等 30 天」。
 */
export function purgeFromTrash(db: DB, appId: string): DB {
  const target = db.applications.find((app) => app.id === appId);
  if (!target) return db;
  return {
    ...db,
    applications: db.applications.filter((app) => app.id !== appId),
    interviews: db.interviews.filter((item) => item.applicationId !== appId),
    notes: db.notes.filter((item) => item.applicationId !== appId),
    experiences: db.experiences.map((exp) =>
      exp.applicationId === appId ? { ...exp, applicationId: null } : exp,
    ),
  };
}

/** 清空回收站：一次真删全部 */
export function emptyTrash(db: DB): DB {
  const doomed = new Set(db.applications.filter((app) => isDeleted(app)).map((app) => app.id));
  if (doomed.size === 0) return db;
  let next = db;
  for (const id of doomed) next = purgeFromTrash(next, id);
  return next;
}

/** 「再留 7 天」：把 deletedAt 往后推，等价于延长到期时间 */
export function extendTrashRetention(db: DB, appId: string, days = TRASH_EXTEND_DAYS): DB {
  const target = db.applications.find((app) => app.id === appId);
  if (!target) return db;
  const base = deletedAtMs(target);
  if (base === null) return db;
  return {
    ...db,
    applications: db.applications.map((app) =>
      app.id === appId ? { ...app, deletedAt: new Date(base + days * DAY_MS).toISOString() } : app,
    ),
  };
}
