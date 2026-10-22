/**
 * 简历与版本的生命周期（ARCH §1.3 / PRD §8）。
 *
 * 这一层**零 React、零 DOM**，全部是「拿一个 DB draft 进来、就地改、返回结果」的纯操作，
 * 由 App.tsx 的 `mutate` + `pushUndo` 包一层就成了可撤销的 api。
 * 这样拆的三个理由：
 * 1. 版本规则（≤30 条、冻结不可变、软删/真删、设主版本）比 UI 复杂得多，
 *    埋在 2876 行的 App.tsx 里就没法单独测；
 * 2. 「一次操作 = 一个撤销点」要求每个函数只做**一件事**，混进 UI 状态就必然有人顺手多改一点；
 * 3. 后续 AI 写回（T07）也要走同一套「改草稿 → 存版本」的路径，不能各写一份。
 *
 * 三条铁律（改这个文件前先读一遍）：
 * 1. **版本是冻结的**：`ResumeVersion.content` 一经创建不许被任何路径改写（含 AI）。
 *    要改已冻结的版本 → `adoptVersionAsDraft` → 编辑 → `saveVersion`。
 * 2. **切模板不删数据**：只改 `templateId` + 用 `ensureSections` 补缺（append-only），
 *    content 是超集，切回来一条都不少。
 * 3. **删版本不动投递**：`Application.resumeVersionId` 悬空是设计的一部分（A-12），
 *    不清空、不校验 —— 那等于替用户做了一个不可撤销的决定。
 */

import type { Application, DB, Resume, ResumeContent, ResumeVersion, TemplateId } from '../types';
import { cloneDB, uid } from '../lib/util';
import { isDeleted } from '../lib/trash';
import { emptyContentOf, ensureSections } from './schema';

/**
 * 每份简历的版本上限（PRD §8 / Q12）。
 *
 * 30 是「够用且不至于让版本菜单变成一堵墙」的折中：一个求职季 8~12 个定向版本
 * 通常够；满了不是不能加，而是要先想清楚删哪个 —— 这正是这条上限想要的效果。
 */
export const VERSION_LIMIT = 30;

/** 到这个数就在版本菜单里给灰字提醒（Q12：第 28 个开始提，第 31 个才硬拒） */
export const VERSION_WARN_AT = 28;

/** 存版本的结果：满额是**预期内的失败**，不是异常，所以用返回值表达 */
export type SaveVersionResult = { ok: true; id: string; label: string } | { ok: false; reason: string };

/* ------------------------------ 撤销快照 ------------------------------ */

/**
 * 一次简历操作的快照：**只有会被这些操作改到的三块**。
 *
 * 为什么不整库回滚（`kind:'import'` 那种）：简历操作不该让「刚记的一条面试」跟着退回去。
 * 撤销的影响面必须等于这次操作的写入面 —— 这是本项目撤销栈一直守的规矩。
 * 三块本身很小（简历几十条、版本几百条上限），快照成本可以忽略。
 */
export interface ResumeSlice {
  resumes: Resume[];
  versions: ResumeVersion[];
  /** `settings.defaultResumeVersionId`（设主版本 / 删版本都会动它） */
  defaultVersionId?: string;
}

export function snapshotResumes(db: DB): ResumeSlice {
  return {
    resumes: cloneDB(db.resumes),
    versions: cloneDB(db.resumeVersions),
    defaultVersionId: db.settings.defaultResumeVersionId,
  };
}

/** 把快照贴回去（撤销与重做共用同一个函数，两条路径不可能漂移） */
export function applyResumeSlice(draft: DB, slice: ResumeSlice): void {
  draft.resumes = cloneDB(slice.resumes);
  draft.resumeVersions = cloneDB(slice.versions);
  draft.settings = { ...draft.settings, defaultResumeVersionId: slice.defaultVersionId };
}

/* ------------------------------ 读 ------------------------------ */

/** 某份简历下的版本，**含已软删的**，按创建时间倒序（新的在前） */
export function versionsOf(db: DB, resumeId: string): ResumeVersion[] {
  return db.resumeVersions
    .filter((version) => version.resumeId === resumeId)
    .slice()
    .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
}

/** 还活着的版本（不在回收站里），倒序 —— 版本菜单的主体 */
export function activeVersionsOf(db: DB, resumeId: string): ResumeVersion[] {
  return versionsOf(db, resumeId).filter((version) => !isDeleted(version));
}

/** 回收站里的版本，删得最晚的在前 —— 内联恢复那一折用 */
export function trashedVersionsOf(db: DB, resumeId: string): ResumeVersion[] {
  return versionsOf(db, resumeId)
    .filter((version) => isDeleted(version))
    .sort((a, b) => timeOf(b.deletedAt ?? '') - timeOf(a.deletedAt ?? ''));
}

/** 占用的版本名额（软删的**不占**：用户可以「删了再加一条」，否则上限会变成死结） */
export function versionQuotaUsed(db: DB, resumeId: string): number {
  return activeVersionsOf(db, resumeId).length;
}

/**
 * 版本菜单顶部的那行灰字（Q12）。
 *
 * 只在接近上限时返回文案，平时返回 null —— 常驻显示「已 3/30」只是噪音。
 * 注意这里**不**做「已满」判定：满了还给存（第 30 个），第 31 个才由 `saveVersion` 拒。
 */
export function versionQuotaHint(db: DB, resumeId: string): string | null {
  const used = versionQuotaUsed(db, resumeId);
  if (used < VERSION_WARN_AT) return null;
  return `已 ${used}/${VERSION_LIMIT}，满了需要先删旧版本`;
}

/** 引用了这个版本的投递（删除前的二次确认要报数字，并说明记录不会丢） */
export function referencingApplications(db: DB, versionId: string): Application[] {
  return db.applications.filter((app) => app.resumeVersionId === versionId && !isDeleted(app));
}

/**
 * 版本显示名：优先版本自己的 label；版本被真删了就退回投递上的快照名。
 *
 * 为什么要这个函数：`resumeVersion` 是**绑定当时的名字快照**（A-12），
 * 版本真删之后它是唯一还能说话的东西 —— 显示成「v3（已删除）」而不是空白。
 */
export function versionLabelFor(db: DB, versionId: string | undefined, fallback?: string): string {
  if (!versionId) return fallback?.trim() || '未绑定';
  const found = db.resumeVersions.find((version) => version.id === versionId);
  if (!found) return `${fallback?.trim() || '已删除的版本'}（已删除）`;
  if (isDeleted(found)) return `${found.label}（已删除）`;
  return found.label;
}

/** 下一个自动名字：v1 / v2 / …（按**含已删**的条数推，避免删了又删出重名） */
export function nextVersionLabel(db: DB, resumeId: string): string {
  return `v${versionsOf(db, resumeId).length + 1}`;
}

/* ------------------------------ 简历 ------------------------------ */

/**
 * 新建一份简历（草稿）。
 *
 * `content` 缺省按模板造一份空内容（板块齐全、字段全空）——
 * 这样「新建 → 打开编辑器」不会看到一张空表单（切模板同理）。
 */
export function createResume(
  draft: DB,
  input: { name: string; templateId: TemplateId; at: string; content?: ResumeContent },
): Resume {
  const name = input.name.trim() || '未命名简历';
  const resume: Resume = {
    id: uid('res'),
    name,
    templateId: input.templateId,
    content: input.content ? cloneDB(input.content) : emptyContentOf(input.templateId),
    createdAt: input.at,
    updatedAt: input.at,
    deletedAt: null,
  };
  draft.resumes.push(resume);
  return resume;
}

/**
 * 复制一份简历：**content 深拷贝，版本历史不带**（PRD §8「复制（不带历史）」）。
 *
 * 为什么不连版本一起复制：版本是一份「投出去过什么」的账。
 * 复制出来的简历一次都还没投过，把 30 个历史版本一起搬过去，
 * 会让「这份简历有几个版本」这个数字从第一天起就是假的。
 */
export function duplicateResume(draft: DB, resumeId: string, at: string): Resume | null {
  const source = draft.resumes.find((resume) => resume.id === resumeId && !isDeleted(resume));
  if (!source) return null;
  const copy: Resume = {
    id: uid('res'),
    name: `${source.name} 副本`,
    templateId: source.templateId,
    content: cloneDB(source.content),
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  draft.resumes.push(copy);
  return copy;
}

/** 改名（id 不变 —— 统计与投递绑定都挂在 id 上） */
export function renameResume(draft: DB, resumeId: string, name: string, at: string): boolean {
  const target = draft.resumes.find((resume) => resume.id === resumeId);
  const next = name.trim();
  if (!target || !next || next === target.name) return false;
  target.name = next;
  target.updatedAt = at;
  return true;
}

/**
 * 切模板：只改 `templateId` + 补缺板块。
 *
 * `ensureSections` 是 append-only（只补缺、不清洗、不重排），所以切走再切回来
 * content 是**超集**：别的模板的字段还在 `items[].fields` 里，一条都不会丢。
 */
export function switchTemplate(draft: DB, resumeId: string, templateId: TemplateId, at: string): boolean {
  const target = draft.resumes.find((resume) => resume.id === resumeId);
  if (!target || target.templateId === templateId) return false;
  target.templateId = templateId;
  target.content = ensureSections(target.content, templateId);
  target.updatedAt = at;
  return true;
}

/** 草稿内容落库（编辑期专用，**不入撤销栈** —— 调用方是 App.updateResumeContent） */
export function writeDraftContent(draft: DB, resumeId: string, content: ResumeContent, at: string): boolean {
  const target = draft.resumes.find((resume) => resume.id === resumeId);
  if (!target) return false;
  target.content = cloneDB(content);
  target.updatedAt = at;
  return true;
}

/** 软删简历（30 天后由启动清理真删，其下版本一并清掉） */
export function softDeleteResume(draft: DB, resumeId: string, at: string): boolean {
  const target = draft.resumes.find((resume) => resume.id === resumeId && !isDeleted(resume));
  if (!target) return false;
  target.deletedAt = at;
  return true;
}

/** 从回收站恢复简历 */
export function restoreResume(draft: DB, resumeId: string): boolean {
  const target = draft.resumes.find((resume) => resume.id === resumeId && isDeleted(resume));
  if (!target) return false;
  target.deletedAt = null;
  return true;
}

/** 永久删除简历（连同其下全部版本，含回收站里的）—— 不可撤销，UI 必须二次确认 */
export function purgeResume(draft: DB, resumeId: string): boolean {
  const exists = draft.resumes.some((resume) => resume.id === resumeId);
  if (!exists) return false;
  draft.resumes = draft.resumes.filter((resume) => resume.id !== resumeId);
  draft.resumeVersions = draft.resumeVersions.filter((version) => version.resumeId !== resumeId);
  return true;
}

/* ------------------------------ 版本 ------------------------------ */

/**
 * 把当前草稿冻结成一个版本。
 *
 * **调用前必须 `flush()` 草稿**（否则最后 400 ms 的输入不在库里 ——
 * 「屏幕上改了、存下来的版本没改」比不存更伤人）。这一点由 App 的
 * `resume.saveVersion` 负责，不是本函数能检查的。
 *
 * 满额时返回 `{ ok:false }` 而不是抛错：这是预期内的分支，调用方要拿它去弹提示。
 */
export function saveVersion(draft: DB, resumeId: string, label: string, at: string): SaveVersionResult {
  const resume = draft.resumes.find((item) => item.id === resumeId && !isDeleted(item));
  if (!resume) return { ok: false, reason: '这份简历已经不在了' };

  const used = versionQuotaUsed(draft, resumeId);
  if (used >= VERSION_LIMIT) {
    return {
      ok: false,
      reason: `版本已满 ${VERSION_LIMIT} 个 —— 先在版本菜单里删掉用不上的旧版本，再存新的`,
    };
  }

  const finalLabel = label.trim() || nextVersionLabel(draft, resumeId);
  // ★ 深拷贝冻结：库里这份从此只读，草稿继续改也不会连带改到它
  const version: ResumeVersion = {
    id: uid('ver'),
    resumeId,
    label: finalLabel,
    templateId: resume.templateId,
    content: cloneDB(resume.content),
    createdAt: at,
    deletedAt: null,
  };
  draft.resumeVersions.push(version);
  return { ok: true, id: version.id, label: finalLabel };
}

/** 改版本名（id 不变 → 投递绑定与统计都不漂移） */
export function renameVersion(draft: DB, versionId: string, label: string): boolean {
  const target = draft.resumeVersions.find((version) => version.id === versionId);
  const next = label.trim();
  if (!target || !next || next === target.label) return false;
  target.label = next;
  return true;
}

/**
 * 设主版本 = 写 `settings.defaultResumeVersionId`（单一事实来源）。
 *
 * 只允许指向**活着的**版本：主版本是「新建投递时默认绑定谁」，
 * 指向一个回收站里的版本等于默认绑一个已经删掉的东西。
 */
export function setPrimaryVersion(draft: DB, versionId: string): boolean {
  const target = draft.resumeVersions.find((version) => version.id === versionId && !isDeleted(version));
  if (!target) return false;
  draft.settings = { ...draft.settings, defaultResumeVersionId: versionId };
  return true;
}

/** 软删版本（被投递引用时**不清空引用**，UI 负责二次确认） */
export function softDeleteVersion(draft: DB, versionId: string, at: string): boolean {
  const target = draft.resumeVersions.find((version) => version.id === versionId && !isDeleted(version));
  if (!target) return false;
  target.deletedAt = at;
  // 主版本被删 → 顺手摘掉这个指针，免得下次新建投递默认绑一个已删版本
  if (draft.settings.defaultResumeVersionId === versionId) {
    draft.settings = { ...draft.settings, defaultResumeVersionId: undefined };
  }
  return true;
}

/** 从回收站恢复版本（主版本指针不自动恢复 —— 那是用户的另一个决定） */
export function restoreVersion(draft: DB, versionId: string): boolean {
  const target = draft.resumeVersions.find((version) => version.id === versionId && isDeleted(version));
  if (!target) return false;
  target.deletedAt = null;
  return true;
}

/** 永久删除版本 —— 投递上的 `resumeVersionId` 故意不动（A-12 悬空引用） */
export function purgeVersion(draft: DB, versionId: string): boolean {
  const exists = draft.resumeVersions.some((version) => version.id === versionId);
  if (!exists) return false;
  draft.resumeVersions = draft.resumeVersions.filter((version) => version.id !== versionId);
  if (draft.settings.defaultResumeVersionId === versionId) {
    draft.settings = { ...draft.settings, defaultResumeVersionId: undefined };
  }
  return true;
}

/**
 * 「以此版本为草稿」：冻结版本 → 可编辑草稿（深拷贝，**不回写版本**）。
 *
 * 连 `templateId` 一起带过去：这个版本当初就是用那套模板冻结的，
 * 拿别的模板渲染出来长得完全不一样，用户会以为内容错了。
 *
 * 版本本身一个字节都不动 —— 这是「冻结不可变」的兑现处。
 */
export function adoptVersionAsDraft(draft: DB, versionId: string, at: string): boolean {
  const version = draft.resumeVersions.find((item) => item.id === versionId && !isDeleted(item));
  if (!version) return false;
  const resume = draft.resumes.find((item) => item.id === version.resumeId && !isDeleted(item));
  if (!resume) return false;
  resume.templateId = version.templateId;
  resume.content = ensureSections(cloneDB(version.content), version.templateId);
  resume.updatedAt = at;
  return true;
}

/* ------------------------------ 内部 ------------------------------ */

/** ISO 串 → 毫秒（非法值给 0，排序时沉底而不是抛 NaN） */
function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}
