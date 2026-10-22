/**
 * 简历页（v0.9 · T05 的一级视图）—— 列表态 / 编辑态二选一。
 *
 * 为什么状态只有「打开了哪份」这一个：简历里真正的复数维度已经有两个了
 * （简历 × 版本），再加「编辑器是否打开」这种布尔状态只会多出一条能对不上的真相。
 * `openedId` 为空就是列表，有值就是编辑，刷新页面后回到列表（不记忆到 localStorage：
 * 用户明天打开时想看的多半是「我有几份简历」，而不是昨天卡在某一行输入框里）。
 *
 * 注意这里用的是 `db.resumes` 而不是过滤过的视图库：回收站折叠区要看到软删的行。
 * 列表主体自己按 `deletedAt` 分两摞（详见 `resume/versions.ts` 的读函数）。
 */

import type { AppApi } from '../../lib/api';
import { ResumeList } from './ResumeList';
import { ResumeEditor } from './ResumeEditor';

export function ResumeView({ api }: { api: AppApi }) {
  const opened = api.resume.openedId
    ? api.resume.list.find((resume) => resume.id === api.resume.openedId) ?? null
    : null;

  // 正在编辑的简历被删掉（列表里点了删除，或别处清理）→ 自动退回列表，不留一个空编辑器
  if (!opened) return <ResumeList api={api} />;
  return <ResumeEditor api={api} resume={opened} />;
}
