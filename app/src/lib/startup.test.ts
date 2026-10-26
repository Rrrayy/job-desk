/**
 * 启动告知纯函数（v0.9.1 / B-12）。
 *
 * 这段逻辑原本埋在 `App.tsx` 的 `useEffect` 里，而那 3,000 行**没有任何测试 import**
 * （组件层用假 api 隔离）—— 也就是说「启动时到底弹哪句话」从 v0.5 起就不可测。
 * 搬成纯函数后，四条分支 + 优先级 + 「什么都不说」全部可以逐条钉住。
 *
 * 这一组真正守住的是**铁律 6（不许静默）**的两个漏洞：
 * - 简历/版本满 30 天被永久删除，v0.9 里 `swept` 算了数却从没送到界面上；
 * - 简历即将到期，此前只有投递会提醒。
 */

import { describe, expect, it } from 'vitest';
import { startupNotice, type StartupSweep } from './startup';
import type { TrashReminder } from './trash';

const noSweep: StartupSweep = {
  removedApps: 0,
  removedInterviews: 0,
  removedNotes: 0,
  removedResumes: 0,
  removedVersions: 0,
};

const noReminder: TrashReminder = { expiring: 0, expired: 0, soonestDaysLeft: null };

const reminder = (expiring: number, days: number | null): TrashReminder => ({
  expiring,
  expired: 0,
  soonestDaysLeft: days,
});

describe('startupNotice · 四条分支（互斥，只弹一条）', () => {
  it('① 投递被真删：带上面试与记录条数（最重的先说）', () => {
    const notice = startupNotice(
      { ...noSweep, removedApps: 3, removedInterviews: 2, removedNotes: 5 },
      noReminder,
      noReminder,
    );
    expect(notice).toBe('回收站里有 3 条投递已满 30 天，已自动永久删除（含 2 场面试、5 条记录）');
  });

  it('★ ② 简历/版本被真删：简历与版本分开计数（否则用户以为只丢了一份东西）', () => {
    const notice = startupNotice({ ...noSweep, removedResumes: 1, removedVersions: 5 }, noReminder, noReminder);
    expect(notice).toContain('1 份简历和 5 个版本');
    expect(notice).toContain('已自动永久删除');
    // 说清它已经不在设置里了，免得用户去回收站找一个不存在的东西
    expect(notice).toContain('不再出现在设置 → 回收站里');
  });

  it('② 只删了版本（简历还在）→ 文案里不出现「0 份简历」', () => {
    const notice = startupNotice({ ...noSweep, removedResumes: 0, removedVersions: 2 }, noReminder, noReminder);
    expect(notice).toContain('2 个版本');
    expect(notice).not.toContain('0 份简历');
    expect(notice).not.toContain('和');
  });

  it('③ 投递将到期：给出剩余天数与「去设置恢复」的指引', () => {
    const notice = startupNotice(noSweep, reminder(2, 1), noReminder);
    expect(notice).toBe('回收站有 2 条投递归将在 1 天内永久删除，可在设置里恢复');
  });

  it('★ ④ 简历将到期：说清「连它下面的版本一起」（v0.9 里这条根本没有）', () => {
    const notice = startupNotice(noSweep, noReminder, reminder(1, 3));
    expect(notice).toContain('1 份简历将在 3 天内永久删除');
    expect(notice).toContain('连它下面的版本一起');
    expect(notice).toContain('可在设置里恢复');
  });

  it('优先级：真删 > 将到期；投递真删 > 简历真删', () => {
    const all = startupNotice(
      { ...noSweep, removedApps: 1, removedInterviews: 0, removedNotes: 0, removedResumes: 2, removedVersions: 3 },
      reminder(1, 2),
      reminder(1, 1),
    );
    expect(all).toContain('1 条投递已满 30 天');

    const resumeOnly = startupNotice({ ...noSweep, removedResumes: 1 }, reminder(4, 2), reminder(9, 1));
    expect(resumeOnly).toContain('1 份简历');
    expect(resumeOnly).toContain('已自动永久删除');

    const appReminderFirst = startupNotice(noSweep, reminder(1, 2), reminder(9, 1));
    expect(appReminderFirst).toContain('1 条投递');
  });

  it('什么都没发生 → null（不弹空 toast）', () => {
    expect(startupNotice(noSweep, noReminder, noReminder)).toBeNull();
  });

  it('soonestDaysLeft 为 null 时兜底成 1（不显示「null 天后删除」）', () => {
    expect(startupNotice(noSweep, reminder(1, null), noReminder)).toContain('1 天内');
    expect(startupNotice(noSweep, noReminder, reminder(1, null))).toContain('1 天内');
  });
});
