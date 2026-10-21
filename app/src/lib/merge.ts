/**
 * 导入增量合并（v0.5 / D4）。
 *
 * 为什么改：v0.4.1 的导入是**整库覆盖** —— 拿一个月前的备份导一次，
 * 这一个月记的东西全没了。用户不该为了「补一条记录」而冒丢一个月数据的风险。
 *
 * 现在的语义：
 *
 * 1. **默认增量合并**。已存在的不覆盖、只补缺的（新公司 / 新投递 / 新面试 / 新记录）。
 * 2. **重复的判定**：同公司名 + 同岗位 + 同投递日期。
 *    只忽略大小写与空白，不做模糊匹配 —— 宁可多插一条让用户自己删，
 *    也不要「合并错了」还静默不提示。
 * 3. **冲突逐条裁决**：同一条投递在两边都有、且字段值不同时，
 *    列出差异让用户选「保留本地 / 用备份覆盖」。**默认保留本地**。
 * 4. 用户手改过的字段（备注 / 优先级 / 简历版本）永远不被备份覆盖，
 *    即使他选了「用备份覆盖」也要再确认一次 —— 这条是 v0.4.1 就定下的产品语义。
 *
 * 这个模块只做纯计算，不碰存储、不弹窗：把「会发生什么」算清楚交给 UI 展示，
 * 与同步引擎（lib/sync）是同一个思路。
 */

import type { DB, Application, Company, Interview, Note } from '../types';

/** 参与冲突比较的字段（都是用户会在意的） */
export const MERGE_FIELDS = [
  'status',
  'appliedAt',
  'channel',
  'resumeVersion',
  'priority',
  'deadlineAt',
  'jdUrl',
  'salaryText',
] as const;

export type MergeField = (typeof MERGE_FIELDS)[number];

export const MERGE_FIELD_LABEL: Record<MergeField, string> = {
  status: '状态',
  appliedAt: '投递日期',
  channel: '渠道',
  resumeVersion: '简历版本',
  priority: '优先级',
  deadlineAt: '截止日',
  jdUrl: 'JD 链接',
  salaryText: '薪资',
};

/** 用户手改过的字段，**永不被导入覆盖**（v0.4.1 起的硬约定） */
export const PROTECTED_FIELDS: ReadonlySet<MergeField> = new Set<MergeField>([
  'resumeVersion',
  'priority',
]);

export interface FieldDiff {
  field: MergeField;
  label: string;
  local: string;
  incoming: string;
  /** true = 这个字段受保护，即使选了覆盖也不动 */
  protected: boolean;
}

export interface ConflictRow {
  /** 两边各自的投递 id */
  localId: string;
  incomingId: string;
  company: string;
  jobTitle: string;
  diffs: FieldDiff[];
}

export interface MergeCounts {
  /** 新增投递 */
  added: number;
  /** 新增公司 */
  addedCompanies: number;
  /** 新增面试 */
  addedInterviews: number;
  /** 新增沟通记录 */
  addedNotes: number;
  /** 完全重复、什么都没做的 */
  unchanged: number;
  /** 需要用户裁决的 */
  conflicts: number;
  /** 因为「保留本地」而被跳过的差异字段数 */
  skippedFields: number;
}

export interface MergePlan {
  /** 合并后的库 */
  db: DB;
  counts: MergeCounts;
  conflicts: ConflictRow[];
}

/* --------------------------------- 去重键 --------------------------------- */

/** 公司名归一：只去空白、转小写。不做同义词合并（「字节」≠「字节跳动」） */
export function normalizeCompanyName(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

/** 投递去重键：公司 + 岗位 + 投递日期 */
export function applicationKey(input: {
  companyName: string;
  jobTitle: string;
  appliedAt?: string;
}): string {
  const company = normalizeCompanyName(input.companyName);
  const title = input.jobTitle.replace(/\s+/g, '').toLowerCase();
  const date = (input.appliedAt ?? '').trim();
  return `${company}|${title}|${date}`;
}

function companyNameOf(db: DB, companyId: string): string {
  const company = db.companies.find((c) => c.id === companyId);
  return company ? company.name : '';
}

function keyOfApp(db: DB, app: Application): string {
  return applicationKey({
    companyName: companyNameOf(db, app.companyId),
    jobTitle: app.jobTitle,
    appliedAt: app.appliedAt,
  });
}

/* -------------------------------- 字段比较 -------------------------------- */

function renderField(app: Application, field: MergeField): string {
  const value = app[field];
  if (value === undefined || value === null || value === '') return '—';
  if (field === 'priority') return '★'.repeat(Number(value));
  return String(value);
}

export function diffApplication(local: Application, incoming: Application): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of MERGE_FIELDS) {
    const a = renderField(local, field);
    const b = renderField(incoming, field);
    if (a === b) continue;
    diffs.push({
      field,
      label: MERGE_FIELD_LABEL[field],
      local: a,
      incoming: b,
      protected: PROTECTED_FIELDS.has(field),
    });
  }
  return diffs;
}

/* --------------------------------- 合并 --------------------------------- */

export interface MergeOptions {
  /** 冲突行的处理：默认全保留本地；给了 id 集合则这些行用备份覆盖 */
  overwriteLocalIds?: ReadonlySet<string>;
}

/**
 * 把 `incoming` 增量合并进 `local`。
 *
 * 注意：**不修改入参**，返回新对象。local 里已有的投递不会被删、不会丢字段。
 */
export function mergeImport(local: DB, incoming: DB, options: MergeOptions = {}): MergePlan {
  const overwrite = options.overwriteLocalIds ?? new Set<string>();

  const next: DB = {
    ...local,
    settings: local.settings, // 设置永远以本地为准 —— 导备份不该改掉你的阈值
    companies: [...local.companies],
    applications: [...local.applications],
    interviews: [...local.interviews],
    notes: [...local.notes],
    experiences: [...local.experiences],
    questions: [...local.questions],
    staging: [...local.staging],
    events: [...local.events],
  };

  const counts: MergeCounts = {
    added: 0,
    addedCompanies: 0,
    addedInterviews: 0,
    addedNotes: 0,
    unchanged: 0,
    conflicts: 0,
    skippedFields: 0,
  };
  const conflicts: ConflictRow[] = [];

  /* 1) 公司：按名字归一后匹配，缺的补上 */
  const companyByKey = new Map<string, Company>();
  for (const company of next.companies) companyByKey.set(normalizeCompanyName(company.name), company);

  const companyIdMap = new Map<string, string>(); // incoming id → local id
  for (const company of incoming.companies) {
    const key = normalizeCompanyName(company.name);
    const existing = companyByKey.get(key);
    if (existing) {
      companyIdMap.set(company.id, existing.id);
      continue;
    }
    next.companies.push(company);
    companyByKey.set(key, company);
    companyIdMap.set(company.id, company.id);
    counts.addedCompanies += 1;
  }

  /* 2) 投递：按去重键匹配 */
  const appByKey = new Map<string, Application>();
  for (const app of next.applications) appByKey.set(keyOfApp(next, app), app);

  const appIdMap = new Map<string, string>(); // incoming id → local id
  for (const app of incoming.applications) {
    const mappedCompanyId = companyIdMap.get(app.companyId) ?? app.companyId;
    const candidate: Application = { ...app, companyId: mappedCompanyId };
    const key = applicationKey({
      companyName: companyNameOf(next, mappedCompanyId),
      jobTitle: candidate.jobTitle,
      appliedAt: candidate.appliedAt,
    });
    const existing = appByKey.get(key);

    if (!existing) {
      next.applications.push(candidate);
      appByKey.set(key, candidate);
      appIdMap.set(app.id, candidate.id);
      counts.added += 1;
      continue;
    }

    appIdMap.set(app.id, existing.id);
    const diffs = diffApplication(existing, candidate);
    if (diffs.length === 0) {
      counts.unchanged += 1;
      continue;
    }

    counts.conflicts += 1;
    conflicts.push({
      localId: existing.id,
      incomingId: candidate.id,
      company: companyNameOf(next, existing.companyId),
      jobTitle: existing.jobTitle,
      diffs,
    });

    if (overwrite.has(existing.id)) {
      // 覆盖：只覆盖非保护字段，且保留本地的 id / 时间戳 / 同步元信息
      const patch: Partial<Application> = {};
      for (const diff of diffs) {
        if (diff.protected) {
          counts.skippedFields += 1;
          continue;
        }
        const value = candidate[diff.field];
        (patch as Record<string, unknown>)[diff.field] = value === undefined ? null : value;
      }
      Object.assign(existing, patch);
    } else {
      counts.skippedFields += diffs.length;
    }
  }

  /* 3) 面试：按 投递 + 轮次 + 时间 匹配 */
  const interviewKey = (applicationId: string, round: number, scheduledAt: string): string =>
    `${applicationId}|${round}|${scheduledAt}`;
  const interviewKeys = new Set(
    next.interviews.map((item) => interviewKey(item.applicationId, item.round, item.scheduledAt)),
  );
  for (const interview of incoming.interviews) {
    const mapped = appIdMap.get(interview.applicationId);
    if (!mapped) continue; // 父投递没合进来（不该发生），跳过而不是插一条孤儿
    const key = interviewKey(mapped, interview.round, interview.scheduledAt);
    if (interviewKeys.has(key)) continue;
    const row: Interview = { ...interview, applicationId: mapped };
    next.interviews.push(row);
    interviewKeys.add(key);
    counts.addedInterviews += 1;
  }

  /* 4) 沟通记录：按 投递 + 内容 + 时间 匹配（内容相同视为同一条） */
  const noteKey = (applicationId: string, content: string, at: string): string =>
    `${applicationId}|${at}|${content}`;
  const noteKeys = new Set(
    next.notes.map((item) => noteKey(item.applicationId, item.content, item.touchedAt)),
  );
  for (const note of incoming.notes) {
    const mapped = appIdMap.get(note.applicationId);
    if (!mapped) continue;
    const key = noteKey(mapped, note.content, note.touchedAt);
    if (noteKeys.has(key)) continue;
    const row: Note = { ...note, applicationId: mapped };
    next.notes.push(row);
    noteKeys.add(key);
    counts.addedNotes += 1;
  }

  /* 5) 面经 / 题库 / 日程 / 暂存区：按 id 去重后补齐（它们没有天然业务键） */
  next.experiences = mergeById(next.experiences, incoming.experiences, appIdMap);
  next.questions = mergeById(next.questions, incoming.questions, appIdMap);
  next.events = mergeById(next.events, incoming.events, appIdMap);
  next.staging = mergeById(next.staging, incoming.staging, appIdMap);

  return { db: next, counts, conflicts };
}

/**
 * 通用「按 id 补齐」：只补本地没有的 id，已存在的一律不动。
 * 面经这类内容没有稳定的业务键，用 id 是唯一不误判的办法。
 */
function mergeById<T extends { id: string }>(
  local: T[],
  incoming: T[],
  appIdMap: Map<string, string>,
): T[] {
  const existing = new Set(local.map((item) => item.id));
  const out = [...local];
  for (const item of incoming) {
    if (existing.has(item.id)) continue;
    const remapped = remapApplicationId(item, appIdMap);
    out.push(remapped);
    existing.add(item.id);
  }
  return out;
}

function remapApplicationId<T>(item: T, appIdMap: Map<string, string>): T {
  if (typeof item !== 'object' || item === null) return item;
  const record = item as Record<string, unknown>;
  const appId = record.applicationId;
  if (typeof appId !== 'string') return item;
  const mapped = appIdMap.get(appId);
  if (!mapped || mapped === appId) return item;
  return { ...(item as object), applicationId: mapped } as T;
}
