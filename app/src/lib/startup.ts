/**
 * 启动告知（v0.9.1 / R-RES-11 + R-AI-10，架构 B-12）。
 *
 * ## 为什么要把这段从 `App.tsx` 搬到纯函数
 *
 * 这段逻辑原本是 `App.tsx` 里的一个 `useEffect`：读 `swept` 与 `trashReminder`，
 * 挑一个 toast 弹出来。问题不在实现，而在**可测性**：`App.tsx` 有 3,000+ 行，
 * 全仓没有一个测试 import 它（组件层用 `api` 假对象隔离）。于是这段「只弹一次、
 * 弹错就永远没人发现」的分支，从 v0.5 起就一直不可测。
 *
 * v0.9.1 要在这里加第三、第四个分支（简历过期、报告被顶），再留在 `App.tsx` 里
 * 就是**四个不可测分支**。搬成一个纯函数：输入是「清理结果 + 两份提醒读数」，
 * 输出是「该说哪句话（或不说）」，一共十几行、全部分支都能被普通单测钉住。
 *
 * ## 四条分支的优先级（互斥，只弹一条）
 *
 * 1. **投递被真删**（`removedApps > 0`）：最重 —— 数据真的没了，且带面试/记录条数；
 * 2. **简历/版本被真删**（`removedResumes + removedVersions > 0`）：v0.9 起这条
 *    一直是哑的（`swept` 算了数，没人用），本版必须说出来；
 * 3. **投递即将到期**：还有救，给「去设置里恢复」的指引；
 * 4. **简历即将到期**：同 3，数据源换成 `resumes`。
 *
 * 为什么互斥而不是排队弹：启动时连弹四个 toast 等于一个都没被读到（v0.5 的注释
 * 原话是「两件事别抢一个 toast」）。真删优先于将到期 —— 已经发生的事实比将要
 * 发生的更急。
 *
 * @module lib/startup
 */

import type { SweepResult, TrashReminder } from './trash';

/** 启动时用到的清理计数（`SweepResult` 的子集，方便测试直接造） */
export type StartupSweep = Pick<
  SweepResult,
  'removedApps' | 'removedInterviews' | 'removedNotes' | 'removedResumes' | 'removedVersions'
>;

/**
 * 算出启动时该说的那句话。
 *
 * @param sweep 启动清理的结果（`sweepTrash` 的返回，去掉 `db`）
 * @param appReminder 投递回收站提醒（`trashReminder`）
 * @param resumeReminder 简历回收站提醒（`resumeTrashReminder`）
 * @returns 该弹的文案；`null` = 什么都不用说
 */
export function startupNotice(
  sweep: StartupSweep,
  appReminder: TrashReminder,
  resumeReminder: TrashReminder,
): string | null {
  if (sweep.removedApps > 0) {
    return `回收站里有 ${sweep.removedApps} 条投递已满 30 天，已自动永久删除（含 ${sweep.removedInterviews} 场面试、${sweep.removedNotes} 条记录）`;
  }
  if (sweep.removedResumes > 0 || sweep.removedVersions > 0) {
    // 简历与版本分开计数：一份简历连带它的版本一起走，只说「1 份简历」会让
    // 用户以为「只删了一份东西」，而实际上他可能丢了 5 个版本。
    const what =
      sweep.removedResumes > 0 && sweep.removedVersions > 0
        ? `${sweep.removedResumes} 份简历和 ${sweep.removedVersions} 个版本`
        : sweep.removedResumes > 0
          ? `${sweep.removedResumes} 份简历`
          : `${sweep.removedVersions} 个版本`;
    return `回收站里有 ${what} 已满 30 天，已自动永久删除（删除后不再出现在设置 → 回收站里）`;
  }
  if (appReminder.expiring > 0) {
    return `回收站有 ${appReminder.expiring} 条投递归将在 ${appReminder.soonestDaysLeft ?? 1} 天内永久删除，可在设置里恢复`;
  }
  if (resumeReminder.expiring > 0) {
    return `回收站有 ${resumeReminder.expiring} 份简历将在 ${resumeReminder.soonestDaysLeft ?? 1} 天内永久删除（连它下面的版本一起），可在设置里恢复`;
  }
  return null;
}
