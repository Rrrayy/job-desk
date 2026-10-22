/**
 * 投递 ↔ 版本绑定（ARCH §4.0 T06）。
 *
 * 为什么单开一个文件：绑定是「投递侧」唯一要写 `resumeBindLog` 的操作，
 * 而它最容易踩的坑是 F9 —— 改个简历版本不该让沉默天数归零、不该往时间线里
 * 塞一条假记录。所以全部逻辑收在这里做成**纯函数**（零 React、零 toast），
 * UI 只负责调 `bindResumeVersion` 并展示结果；F9 的「不做某些事」用测试钉死。
 *
 * 三条口径（ARCH/PRD 裁决）：
 * 1. **只许绑冻结版本**：候选列表只出「活的版本」（草稿根本不是版本，
 *    结构上就不可能被选中）；目标版本或它所属的简历被软删后，绑定请求直接拒绝。
 * 2. **悬空是设计的一部分**（A-12）：版本被删/清理后 `resumeVersionId` 原样留着，
 *    显示侧退回绑定当时的快照名 +「（已删除）」—— 绝不空白、绝不报错，
 *    投递记录也绝不因为版本删除而丢。
 * 3. **留痕 ≠ 改活跃度**：每次绑定/改绑/解绑追加一条 `ResumeBindLogEntry`
 *    （定长 ≤ 20，超出丢最旧），只碰 `updatedAt`；`lastActivityAt`、notes、
 *    时间线一概不动（F9，测试里有显式回归）。
 */

import type { Application, DB, ResumeBindLogEntry } from '../types';
import { RESUME_BIND_LOG_LIMIT } from '../types';
import { isDeleted } from '../lib/trash';
import { UNBOUND_LEGACY_LABEL, UNLABELED_RESUME_LABEL } from '../lib/rules';
import { versionLabelFor } from './versions';

/** 一条投递的绑定状态（`resolveBoundVersion` 的四分支） */
export type BindState = 'bound' | 'dangling' | 'legacy' | 'none';

export interface BoundVersionView {
  state: BindState;
  /** 悬空时也原样带回（列表按 id 筛选要用），未绑定为 null */
  versionId: string | null;
  /** 展示名：正常 = 版本 label；悬空 = 快照名（已删除）；旧数据 = 未绑定（旧数据） */
  label: string;
}

/**
 * 解析一条投递当前绑到了哪（三分支 + 未标注，显示与统计共用的同一份真相）。
 *
 * - `bound`：id 还指着一块活的版本；
 * - `dangling`：id 在但版本没了（真删或软删）—— 悬空，不算错；
 * - `legacy`：只有旧的文本快照（v0.9 之前的数据），统一「未绑定（旧数据）」；
 * - `none`：什么都没有。
 */
export function resolveBoundVersion(db: DB, app: Application): BoundVersionView {
  if (app.resumeVersionId) {
    const version = db.resumeVersions.find((item) => item.id === app.resumeVersionId);
    if (version && !isDeleted(version)) {
      return { state: 'bound', versionId: version.id, label: version.label };
    }
    return { state: 'dangling', versionId: app.resumeVersionId, label: versionLabelFor(db, app.resumeVersionId, app.resumeVersion) };
  }
  if (app.resumeVersion) {
    return { state: 'legacy', versionId: null, label: UNBOUND_LEGACY_LABEL };
  }
  return { state: 'none', versionId: null, label: UNLABELED_RESUME_LABEL };
}

/** 绑定下拉里的一个候选（只出活版本；简历被删的版本也不能绑） */
export interface BindCandidate {
  versionId: string;
  /** 版本自己的名字（改过名就跟新名，投递上的快照只是历史） */
  label: string;
  /** 所属简历名：同名版本很多，「v1」到底是谁的要靠它分辨 */
  resumeName: string;
}

/**
 * 可绑定的版本候选：所有活简历 × 活版本。
 * 草稿不在候选里 —— 草稿会一直变，「投递时用的是哪版」这个问题它回答不了；
 * 只有「存为新版本」冻结下来的版本才有资格被投递引用（PRD §8）。
 */
export function candidateVersions(db: DB): BindCandidate[] {
  const names = new Map<string, string>();
  for (const resume of db.resumes) {
    if (!isDeleted(resume)) names.set(resume.id, resume.name);
  }
  return db.resumeVersions
    .filter((version) => !isDeleted(version) && names.has(version.resumeId))
    .map((version) => ({ versionId: version.id, label: version.label, resumeName: names.get(version.resumeId) ?? '' }))
    .sort(
      (a, b) =>
        a.resumeName.localeCompare(b.resumeName, 'zh-Hans-CN') ||
        a.label.localeCompare(b.label, 'zh-Hans-CN'),
    );
}

/** 追加一条留痕并截断到上限（超出丢最旧 —— 留最近的操作才有回看价值） */
function appendLog(log: ResumeBindLogEntry[], entry: ResumeBindLogEntry): ResumeBindLogEntry[] {
  const next = [...log, entry];
  return next.length > RESUME_BIND_LOG_LIMIT ? next.slice(next.length - RESUME_BIND_LOG_LIMIT) : next;
}

/**
 * 绑定 / 改绑 / 解绑（`versionId = null` = 解绑）。
 *
 * 返回 false 的情形（都是「什么都没改」，调用方不必提示失败原因）：
 * 投递不存在或在回收站、目标版本不存在/被删/所属简历被删、绑的就是当前版本、
 * 解绑一个本来就没绑的投递。
 *
 * ★ F9：本函数是全库唯一写 `resumeBindLog` 的地方，且**只**碰
 *   `resumeVersionId` / `resumeVersion` / `resumeBindLog` / `updatedAt` 四个字段 ——
 *   `lastActivityAt`、`statusChangedAt`、notes、时间线一概不碰（测试钉死）。
 */
export function bindResumeVersion(draft: DB, appId: string, versionId: string | null, at: string): boolean {
  const app = draft.applications.find((item) => item.id === appId && !isDeleted(item));
  if (!app) return false;

  if (versionId === null) {
    if (!app.resumeVersionId && !app.resumeVersion) return false;
    app.resumeVersionId = undefined;
    app.resumeVersion = undefined;
    app.resumeBindLog = appendLog(app.resumeBindLog ?? [], { label: '已解绑', at });
    app.updatedAt = at;
    return true;
  }

  const version = draft.resumeVersions.find((item) => item.id === versionId && !isDeleted(item));
  if (!version) return false;
  const resume = draft.resumes.find((item) => item.id === version.resumeId && !isDeleted(item));
  if (!resume) return false;
  if (app.resumeVersionId === versionId) return false;

  app.resumeVersionId = version.id;
  // 快照 = 绑定当时的版本名：版本以后改名/被删，投递上仍能说出「当时投的是哪版」
  app.resumeVersion = version.label;
  app.resumeBindLog = appendLog(app.resumeBindLog ?? [], { versionId: version.id, label: version.label, at });
  app.updatedAt = at;
  return true;
}
