/**
 * 合并引擎：plan() / apply() / revertSync() —— 全部是纯函数。
 *
 * ★ 本文件有两条**绝对不能违背**的语义（架构 D-07 / D-10）：
 *
 * 1. 同步写的 note，`touchedAt` **只能**用平台给的 `lastContactAt`。
 *    拿不到平台时间就**不写 note**（绝不用抓取时刻兜底）。
 *    原因：用抓取时刻会让 20 条沉默 20 天的记录瞬间全绿 —— 那是在骗用户。
 *
 * 2. `lastActivityAt` 一律走 `max()` 语义（复用 rules.lastActivityAtOf），
 *    **禁止**调用 App.addNote（它是赋值语义，会把沉默基准往回调）。
 *
 * 3. 无变化的记录**不写 note**，只刷 `sync.lastSyncedAt` 心跳。
 */

import type {
  Application,
  DB,
  Note,
  PlatformId,
  StagedReason,
  StagedSyncItem,
  Status,
} from '../../types';
import type { NormalizedRecord } from '../../adapters/types';
import { fmtDateTime } from '../date';
import { STATUS_LABEL, lastActivityAtOf } from '../rules';
import { cloneDB, uid } from '../util';
import { NORMALIZE_VERSION, TITLE_SIMILARITY, diceCoefficient, normalizeCompanyName, normalizeJobTitle } from './normalize';
import { CHANNEL_BY_PLATFORM, FIELD_OWNERSHIP, SYNC_WRITABLE } from './ownership';
import { SYNC_STATUS_RANK, mapPlatformStatus } from './statusMap';
import type {
  ApplyOptions,
  ApplyResult,
  MatchBy,
  MergeCounts,
  MergePlan,
  PlannedChange,
  PlannedRow,
  SyncUndo,
} from './types';

/** 暂存上限（PRD §D.1） */
export const STAGING_LIMIT = 200;

export interface PlanInput {
  records: NormalizedRecord[];
  db: DB;
  platform: PlatformId;
  capturedAt: string;
  overrides: Record<string, Status | null>;
  /** settings.sync.autoRefreshActivity */
  autoRefreshActivity: boolean;
  /** 注入的「现在」，用于补 appliedAt 的默认日期 */
  now: string;
  /**
   * 适配器解析失败的条目（QA D1）。plan 原样带给 UI，apply 时写进暂存区。
   * 不传 = 解析失败的条目在计划里不可见 —— 那正是 D1 的自相矛盾来源。
   */
  unparsed?: { rawSnippet: string; reason: string }[];
}

const timeOf = (value?: string | null): number => {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

const isLater = (a?: string | null, b?: string | null): boolean => timeOf(a) > timeOf(b);

const laterIso = (a?: string | null, b?: string | null): string | undefined => {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return timeOf(a) >= timeOf(b) ? a : b;
};

/** 平台时间的日期部分 YYYY-MM-DD（本地） */
function datePartOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const mm = `${date.getMonth() + 1}`.padStart(2, '0');
  const dd = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** 记录 → 暂存/去重 key（与 validateV2 / UI 共用同一个口径） */
export function stageKeyOfRecord(record: NormalizedRecord): string {
  return `${record.externalId ?? ''}|${normalizeCompanyName(record.companyName)}|${normalizeJobTitle(record.jobTitle ?? '')}`;
}

export function stageKeyOfItem(item: StagedSyncItem): string {
  return `${item.externalId ?? ''}|${normalizeCompanyName(item.parsed.companyName)}|${normalizeJobTitle(item.parsed.jobTitle ?? '')}`;
}

/** 归一化后的岗位名与本地投递的相似度（无岗位时返回 0） */
function similarityOf(app: Application, record: NormalizedRecord): number {
  if (!record.jobTitle || !app.jobTitle) return 0;
  return diceCoefficient(normalizeJobTitle(app.jobTitle), normalizeJobTitle(record.jobTitle));
}

/**
 * 计算合并计划。
 * 每一步都产出恰好一行（`rows.length === records.length`），并在末尾校验计数不变式。
 */
export function plan(input: PlanInput): MergePlan {
  const { records, db, platform, capturedAt, overrides, autoRefreshActivity } = input;
  const companyNameOf = (app: Application): string => {
    const company = db.companies.find((item) => item.id === app.companyId);
    return company ? company.name : '';
  };

  const rows: PlannedRow[] = [];
  const seenKeys = new Set<string>();
  const counts: MergeCounts = { new: 0, update: 0, unchanged: 0, conflict: 0, staged: 0 };

  records.forEach((record) => {
    const rnCompany = normalizeCompanyName(record.companyName);
    const rnTitle = normalizeJobTitle(record.jobTitle ?? '');
    const matchKey = `${rnCompany}|${rnTitle}`;
    const baseKey = `${record.externalId ?? ''}|${matchKey}`;
    let key = baseKey;
    let duplicate = false;
    if (seenKeys.has(baseKey)) {
      duplicate = true;
      let n = 2;
      while (seenKeys.has(`${baseKey}#${n}`)) n += 1;
      key = `${baseKey}#${n}`;
    }
    seenKeys.add(key);

    const mapped = mapPlatformStatus(record.status ?? record.platformStatusText, overrides);
    const warnings: string[] = [];

    /* ---------- 阶段 1：定位目标（5 级顺序敏感） ---------- */
    let target: Application | undefined;
    let matchedBy: MatchBy | undefined;
    let similarity: number | undefined;
    let candidates: Application[] = [];

    if (record.externalId) {
      target = db.applications.find(
        (app) => app.sync?.platform === platform && app.sync?.externalId === record.externalId,
      );
      if (target) matchedBy = 'externalId';
    }

    if (!target && rnTitle !== '') {
      target = db.applications.find(
        (app) =>
          app.sync?.matchKey === matchKey && app.sync?.matchKeyVersion === NORMALIZE_VERSION,
      );
      if (target) matchedBy = 'matchKey';
    }

    if (!target && rnTitle !== '') {
      const hits = db.applications.filter(
        (app) =>
          normalizeCompanyName(companyNameOf(app)) === rnCompany &&
          Boolean(app.jobTitle) &&
          similarityOf(app, record) >= TITLE_SIMILARITY,
      );
      if (hits.length === 1) {
        target = hits[0];
        matchedBy = 'company+title';
        similarity = similarityOf(hits[0], record);
      } else if (hits.length > 1) {
        candidates = hits;
      }
    }

    if (!target && candidates.length === 0) {
      const hits = db.applications.filter(
        (app) => normalizeCompanyName(companyNameOf(app)) === rnCompany && !app.jobTitle,
      );
      if (hits.length === 1) {
        target = hits[0];
        matchedBy = 'company+emptyTitle';
      } else if (hits.length > 1) {
        candidates = hits;
      }
    }

    const pushRow = (row: PlannedRow): void => {
      // 模糊匹配命中时把相似度带给 UI（'按公司+岗位相似' 需要它解释「为什么算同一条」）
      if (row.similarity === undefined && similarity !== undefined) row.similarity = similarity;
      rows.push(row);
      counts[row.kind] += 1;
    };

    /* ---------- 阶段 1.5：多条候选 → 暂存，不猜 ---------- */
    if (candidates.length > 1 || duplicate) {
      pushRow({
        key,
        kind: 'staged',
        record,
        mappedStatus: mapped.status,
        changes: [],
        stagedReason: 'ambiguous',
        candidateAppIds: candidates.map((app) => app.id),
        defaultChecked: false,
        warnings: duplicate
          ? ['本次粘贴里有两条一样的公司 + 岗位，已放进暂存，避免重复新建']
          : [`有 ${candidates.length} 条疑似同公司同岗位，请先合并或手动指定`],
      });
      return;
    }

    /* ---------- 阶段 3：无目标 → 新增 / 待归类 ---------- */
    if (!target) {
      if (mapped.status === null) {
        pushRow({
          key,
          kind: 'staged',
          record,
          mappedStatus: null,
          changes: [],
          stagedReason: 'unmapped',
          defaultChecked: false,
          warnings: ['状态读不出来，需要你归类'],
        });
        return;
      }
      if (!record.jobTitle) {
        pushRow({
          key,
          kind: 'staged',
          record,
          mappedStatus: mapped.status,
          changes: [],
          stagedReason: 'ambiguous',
          defaultChecked: false,
          warnings: ['缺岗位名，先放暂存，补齐后再合并'],
        });
        return;
      }
      const changes: PlannedChange[] = [{ field: 'status', to: mapped.status }];
      if (record.jobTitle) changes.push({ field: 'jobTitle', to: record.jobTitle });
      if (record.city) changes.push({ field: 'city', to: record.city });
      if (record.salaryText) changes.push({ field: 'salaryText', to: record.salaryText });
      if (record.jdUrl) changes.push({ field: 'jdUrl', to: record.jdUrl });
      if (record.lastContactAt) changes.push({ field: 'lastActivityAt', to: record.lastContactAt });
      if (record.overall === 'low') warnings.push('置信度低，建议先核对再勾选');
      pushRow({
        key,
        kind: 'new',
        record,
        mappedStatus: mapped.status,
        changes,
        blockedBy: record.overall === 'low' ? 'low-confidence' : undefined,
        defaultChecked: record.overall !== 'low',
        warnings,
      });
      return;
    }

    /* ---------- 阶段 4：有目标 → 逐字段按 ownership 决策 ---------- */
    const changes: PlannedChange[] = [];
    for (const field of SYNC_WRITABLE) {
      if (field === 'status') continue; // 阶段 5 单独判定
      const ownership = FIELD_OWNERSHIP[field];
      const localValue = target[field];
      const isEmpty = localValue === undefined || localValue === null || localValue === '';

      if (ownership === 'fill-only' || ownership === 'set-once') {
        const incoming = incomingValueOf(record, field, platform);
        // appliedAt 由状态动作决定，这里单独处理（below）
        if (field === 'appliedAt') continue;
        if (isEmpty && incoming) {
          changes.push({ field, from: undefined, to: incoming });
        }
      } else if (ownership === 'platform-later-only') {
        if (record.lastContactAt && autoRefreshActivity && isLater(record.lastContactAt, target.lastActivityAt)) {
          changes.push({
            field: 'lastActivityAt',
            from: target.lastActivityAt,
            to: record.lastContactAt,
          });
        }
      }
    }

    const platformTime = record.lastContactAt ?? capturedAt;
    const editedAt = target.userEditedAt?.status;

    /* ---------- 阶段 5：status 冲突判定 ---------- */
    if (mapped.status === null) {
      pushRow({
        key,
        kind: 'staged',
        targetAppId: target.id,
        matchedBy,
        record,
        mappedStatus: null,
        changes: [],
        stagedReason: 'unmapped',
        defaultChecked: false,
        warnings: ['平台状态读不出来，这一行整条延后（不会写任何字段）'],
      });
      return;
    }

    if (mapped.status === target.status) {
      // 状态一致：只可能补 appliedAt + 刷活动时间
      if (mapped.action === 'fillAppliedAt' && !target.appliedAt && record.lastContactAt) {
        changes.push({ field: 'appliedAt', to: datePartOf(record.lastContactAt) });
      }
      if (changes.length === 0) {
        pushRow({
          key,
          kind: 'unchanged',
          targetAppId: target.id,
          matchedBy,
          record,
          mappedStatus: mapped.status,
          changes: [],
          defaultChecked: false,
          warnings: ['状态一致，仅记一次同步时间'],
        });
        return;
      }
      pushRow({
        key,
        kind: 'update',
        targetAppId: target.id,
        matchedBy,
        record,
        mappedStatus: mapped.status,
        changes,
        defaultChecked: true,
        warnings,
      });
      return;
    }

    if (editedAt && isLater(editedAt, platformTime)) {
      pushRow({
        key,
        kind: 'conflict',
        targetAppId: target.id,
        matchedBy,
        record,
        mappedStatus: mapped.status,
        changes: [],
        blockedBy: 'user-edited',
        conflict: {
          field: 'status',
          local: target.status,
          platform: mapped.status,
          localRank: SYNC_STATUS_RANK[target.status],
          platformRank: SYNC_STATUS_RANK[mapped.status],
          userEditedAt: editedAt,
        },
        defaultChecked: false,
        warnings: [`你 ${fmtDateTime(editedAt)} 手动改过状态，平台数据更旧`],
      });
      return;
    }

    if (SYNC_STATUS_RANK[mapped.status] > SYNC_STATUS_RANK[target.status]) {
      changes.unshift({ field: 'status', from: target.status, to: mapped.status });
      if (mapped.action === 'fillAppliedAt' && !target.appliedAt && record.lastContactAt) {
        changes.push({ field: 'appliedAt', to: datePartOf(record.lastContactAt) });
      }
      if (mapped.confidence !== 'high') {
        warnings.push('平台文案只能中置信度解释，可能只是你单方面发过消息');
      }
      if (mapped.action === 'todoInterview') {
        warnings.push('平台邀面了，合并后记得去约时间');
      }
      if (mapped.action === 'promptInterviewRecord') {
        warnings.push('平台已面完，合并后补一场面试记录');
      }
      pushRow({
        key,
        kind: 'update',
        targetAppId: target.id,
        matchedBy,
        record,
        mappedStatus: mapped.status,
        changes,
        defaultChecked: mapped.confidence === 'high',
        warnings,
      });
      return;
    }

    if (SYNC_STATUS_RANK[mapped.status] < SYNC_STATUS_RANK[target.status]) {
      pushRow({
        key,
        kind: 'conflict',
        targetAppId: target.id,
        matchedBy,
        record,
        mappedStatus: mapped.status,
        changes: [],
        blockedBy: 'platform-behind',
        conflict: {
          field: 'status',
          local: target.status,
          platform: mapped.status,
          localRank: SYNC_STATUS_RANK[target.status],
          platformRank: SYNC_STATUS_RANK[mapped.status],
        },
        defaultChecked: false,
        warnings: [`平台状态落后于你（${STATUS_LABEL[target.status]} → ${STATUS_LABEL[mapped.status]}），建议以你为准`],
      });
      return;
    }

    // 同 rank 不同值（极少见）
    pushRow({
      key,
      kind: 'conflict',
      targetAppId: target.id,
      matchedBy,
      record,
      mappedStatus: mapped.status,
      changes: [],
      blockedBy: 'same-rank-diff',
      conflict: {
        field: 'status',
        local: target.status,
        platform: mapped.status,
        localRank: SYNC_STATUS_RANK[target.status],
        platformRank: SYNC_STATUS_RANK[mapped.status],
      },
      defaultChecked: false,
      warnings: ['平台和你对同一阶段的说法不同，默认以你为准'],
    });
  });

  return {
    platform,
    capturedAt,
    parsedCount: records.length,
    unparsed: input.unparsed ?? [],
    counts,
    rows,
  };
}

/** 记录里对应字段的值（用于 fill-only / set-once） */
function incomingValueOf(
  record: NormalizedRecord,
  field: keyof Application,
  platform: PlatformId,
): string | undefined {
  switch (field) {
    case 'jobTitle':
      return record.jobTitle;
    case 'jdUrl':
      return record.jdUrl;
    case 'city':
      return record.city;
    case 'salaryText':
      return record.salaryText;
    case 'channel':
      return CHANNEL_BY_PLATFORM[platform];
    default:
      return undefined;
  }
}

/* ================================ apply ================================ */

/**
 * 把计划落库。**只处理 checked !== false 的行**；未勾选的冲突/待归类/新增 → 暂存。
 * 返回值里的 db 是一份全新的深拷贝，调用方按 mutate 的语义整体替换即可。
 */
export function apply(db: DB, opts: ApplyOptions): ApplyResult {
  const next: DB = cloneDB(db);
  const undo: SyncUndo = {
    id: uid('su'),
    at: opts.now,
    platform: opts.platform,
    apps: [],
    createdCompanyIds: [],
    noteIds: [],
    stagedAddedIds: [],
    stagedRemoved: [],
    source: { platform: opts.platform, capturedAt: opts.capturedAt },
  };
  let written = 0;
  let staged = 0;
  let discarded = 0;

  interface Touched {
    app: Application;
    before: Application | null;
    record: NormalizedRecord;
    statusChanged: boolean;
  }
  const touched: Touched[] = [];
  const rowsForStaging: Array<{ row: PlannedRow; reason: StagedReason }> = [];

  for (const row of opts.rows) {
    // 没有显式勾选状态时，以计划里的 defaultChecked 为准（UI 只在用户动过之后才写 checked）
    const checked = row.checked ?? row.defaultChecked;

    // 同一行重新同步时，先把暂存区里的残留删掉（记入 undo 以便撤销时放回）。
    // 这一步必须放在 kind 判断之前：否则「待归类」的行每次同步都会再堆一条。
    const rowKey = stageKeyOfRecord(row.record);
    for (let i = next.staging.length - 1; i >= 0; i -= 1) {
      if (stageKeyOfItem(next.staging[i]) === rowKey) {
        undo.stagedRemoved.push({ id: next.staging[i].id, item: next.staging[i] });
        next.staging.splice(i, 1);
      }
    }

    if (row.kind === 'staged') {
      rowsForStaging.push({ row, reason: row.stagedReason ?? 'unmapped' });
      continue;
    }
    // unchanged 行不参与勾选：它的唯一动作是刷 sync.lastSyncedAt 心跳（不写 note、不碰活动时间）
    if (!checked && row.kind !== 'unchanged') {
      if (row.kind === 'conflict') rowsForStaging.push({ row, reason: 'conflict' });
      else if (row.kind === 'new') rowsForStaging.push({ row, reason: 'unmapped' });
      continue;
    }

    const platformTime = row.record.lastContactAt ?? opts.capturedAt;
    const matchKey = `${normalizeCompanyName(row.record.companyName)}|${normalizeJobTitle(row.record.jobTitle ?? '')}`;

    if (row.kind === 'new' && row.mappedStatus) {
      const companyName = row.record.companyName;
      let company = next.companies.find((item) => item.name === companyName);
      if (!company) {
        const id = uid('c');
        company = { id, name: companyName, city: row.record.city, createdAt: opts.now };
        next.companies.push(company);
        undo.createdCompanyIds.push(id);
      }
      const app: Application = {
        id: uid('app'),
        companyId: company.id,
        jobTitle: row.record.jobTitle ?? '',
        jobType: 'daily',
        city: row.record.city,
        channel: CHANNEL_BY_PLATFORM[opts.platform],
        appliedAt:
          row.mappedStatus === 'applied'
            ? row.record.lastContactAt
              ? datePartOf(row.record.lastContactAt)
              : datePartOf(opts.now)
            : undefined,
        status: row.mappedStatus,
        statusChangedAt: platformTime,
        lastActivityAt: platformTime,
        jdUrl: row.record.jdUrl,
        resumeVersion: undefined,
        salaryText: row.record.salaryText,
        daysPerWeek: undefined,
        durationMonths: undefined,
        silenceOverride: null,
        rejectedAtRound: null,
        nextActionAt: null,
        priority: undefined,
        tags: [],
        createdAt: opts.now,
        updatedAt: opts.now,
        sync: {
          platform: opts.platform,
          externalId: row.record.externalId,
          matchKey,
          matchKeyVersion: NORMALIZE_VERSION,
          platformStatusRaw: row.record.status ?? row.record.platformStatusText,
          lastContactAt: row.record.lastContactAt,
          lastSyncedAt: opts.now,
        },
        userEditedAt: {},
      };
      next.applications.push(app);
      undo.apps.push({ appId: app.id, before: null });
      touched.push({ app, before: null, record: row.record, statusChanged: true });
      written += 1;
      continue;
    }

    const target = next.applications.find((item) => item.id === row.targetAppId);
    if (!target) continue;
    const before = cloneDB(target);
    const previousStatus = target.status;

    if (row.kind === 'update' || row.kind === 'conflict') {
      /*
       * ★ QA D3：冲突行以前 `changes` 恒为 `[]`，勾了等于没做 ——
       * 但 statusChanged 又按「映射状态 ≠ 本地状态」算，于是写出「状态 已发 Offer → 已发 Offer」。
       * 现在把「勾选」这件事本身当成用户的明确选择：勾 = 用平台状态覆盖本地。
       * 默认不勾（plan 给的 defaultChecked=false），所以「什么都不做」= 保留本地。
       */
      if (row.kind === 'conflict' && row.mappedStatus && target.status !== row.mappedStatus) {
        target.status = row.mappedStatus;
        target.statusChangedAt = platformTime;
        if (row.mappedStatus === 'rejected') target.rejectedAtRound = target.rejectedAtRound ?? null;
      }
      for (const change of row.changes) {
        switch (change.field) {
          case 'status':
            if (row.mappedStatus) {
              target.status = row.mappedStatus;
              target.statusChangedAt = platformTime;
              if (row.mappedStatus === 'rejected') target.rejectedAtRound = target.rejectedAtRound ?? null;
            }
            break;
          case 'lastActivityAt':
            if (change.to) target.lastActivityAt = change.to;
            break;
          case 'appliedAt':
            if (change.to) target.appliedAt = change.to;
            break;
          case 'jobTitle':
            if (change.to) target.jobTitle = change.to;
            break;
          case 'jdUrl':
            if (change.to) target.jdUrl = change.to;
            break;
          case 'city':
            if (change.to) target.city = change.to;
            break;
          case 'salaryText':
            if (change.to) target.salaryText = change.to;
            break;
          case 'channel':
            if (change.to) target.channel = change.to as Application['channel'];
            break;
          case 'statusChangedAt':
            if (change.to) target.statusChangedAt = change.to;
            break;
          default:
            break;
        }
      }
      // ★ 绝不写 userEditedAt（那是用户行为的产物）
      target.sync = {
        ...(target.sync ?? { platform: opts.platform }),
        platform: opts.platform,
        externalId: row.record.externalId ?? target.sync?.externalId,
        matchKey,
        matchKeyVersion: NORMALIZE_VERSION,
        platformStatusRaw: row.record.status ?? row.record.platformStatusText,
        lastContactAt: laterIso(target.sync?.lastContactAt, row.record.lastContactAt),
        lastSyncedAt: opts.now,
      };
      target.updatedAt = opts.now;
      undo.apps.push({ appId: target.id, before });
      touched.push({
        app: target,
        before,
        record: row.record,
        // ★ QA D3：**写入之后**与写入之前比较，没变就是没变。
        // 以前用「映射状态 ≠ 本地状态」，冲突行没写状态也判成「变了」→ 时间线出现 A → A。
        statusChanged: target.status !== previousStatus,
      });
      written += 1;
      continue;
    }

    if (row.kind === 'unchanged') {
      // 只刷心跳，绝不碰 lastActivityAt / 不写 note
      target.sync = {
        ...(target.sync ?? { platform: opts.platform }),
        platform: opts.platform,
        externalId: row.record.externalId ?? target.sync?.externalId,
        matchKey,
        matchKeyVersion: NORMALIZE_VERSION,
        platformStatusRaw: row.record.status ?? row.record.platformStatusText,
        lastContactAt: laterIso(target.sync?.lastContactAt, row.record.lastContactAt),
        lastSyncedAt: opts.now,
      };
      undo.apps.push({ appId: target.id, before });
      touched.push({ app: target, before, record: row.record, statusChanged: false });
      // 心跳不计入「将写入 N 条」
    }
  }

  /* ---------- 写 note：每个被写入的 app 最多 1 条 ---------- */
  for (const item of touched) {
    const { app, record, statusChanged } = item;
    const previousActivity = item.before ? item.before.lastActivityAt : undefined;
    const timeRefreshed =
      Boolean(record.lastContactAt) &&
      (!previousActivity || isLater(record.lastContactAt, previousActivity));

    if (!statusChanged && !timeRefreshed) continue;
    // ★ D-07：拿不到平台业务时间就不写 note（绝不用抓取时刻）
    const touchedAt = record.lastContactAt;
    if (!touchedAt) continue;

    const platformName = platformLabelOf(opts.platform);
    let content: string;
    if (item.before === null) {
      content = `平台同步：新建记录，状态 ${STATUS_LABEL[app.status]}（${platformName} · 平台时间 ${fmtDateTime(touchedAt)}）`;
    } else if (statusChanged) {
      content = `平台同步：状态 ${STATUS_LABEL[item.before.status]} → ${STATUS_LABEL[app.status]}（${platformName} · 平台时间 ${fmtDateTime(touchedAt)}）`;
    } else {
      content = `平台同步：对方 ${fmtDateTime(touchedAt)} 有新消息（${platformName}）`;
    }

    const note: Note = {
      id: uid('n'),
      applicationId: app.id,
      type: 'sync',
      content,
      auto: true,
      touchedAt,
      source: {
        platform: opts.platform,
        externalId: record.externalId,
        capturedAt: opts.capturedAt,
        platformTime: touchedAt,
      },
    };
    next.notes.push(note);
    undo.noteIds.push(note.id);
  }

  /* ---------- 重算 lastActivityAt（max 语义 + 不倒退护栏） ---------- */
  for (const item of touched) {
    const computed = lastActivityAtOf(item.app, next.notes);
    const previous = item.before ? item.before.lastActivityAt : computed;
    // 只用 max 语义：既不用 opts.now，也不允许把沉默基准往回调
    item.app.lastActivityAt = laterIso(computed, previous) ?? computed;
  }

  /* ---------- 未勾选 / 待归类 → 暂存 ---------- */
  for (const { row, reason } of rowsForStaging) {
    const item: StagedSyncItem = {
      id: uid('st'),
      platform: opts.platform,
      externalId: row.record.externalId,
      parsed: row.record,
      candidateAppId: row.targetAppId ?? row.candidateAppIds?.[0],
      reason,
      platformStatusRaw: row.record.status ?? row.record.platformStatusText,
      capturedAt: opts.capturedAt,
    };
    next.staging.push(item);
    undo.stagedAddedIds.push(item.id);
    staged += 1;
  }

  /*
   * ---------- 解析失败（adapter.unparsed）→ 暂存（QA D1） ----------
   *
   * 以前这里什么都不做：第 ② 步写着「1 条没解析出来（不会丢，会进待归类）」，
   * 第 ④ 步却显示「没有遗留待归类记录」，`db.staging` 0 → 0 —— 那条记录真的没了。
   *
   * 现在：原文片段（≤500 字）+ 失败原因一起进暂存，用户在待归类页能看见、能补录、能丢弃。
   * 去重口径用原文片段本身：同一条垃圾文本重复粘贴不会堆成两条。
   */
  for (const item of opts.unparsed ?? []) {
    const snippet = item.rawSnippet ?? '';
    if (!snippet.trim()) continue;
    for (let i = next.staging.length - 1; i >= 0; i -= 1) {
      const entry = next.staging[i];
      if (entry.reason === 'unparsed' && (entry.rawSnippet ?? '') === snippet) {
        undo.stagedRemoved.push({ id: entry.id, item: entry });
        next.staging.splice(i, 1);
      }
    }
    const stagedItem: StagedSyncItem = {
      id: uid('st'),
      platform: opts.platform,
      parsed: {
        companyName: '',
        confidence: {},
        overall: 'low',
        rawSnippet: snippet,
      },
      reason: 'unparsed',
      rawSnippet: snippet,
      reasonText: item.reason,
      capturedAt: opts.capturedAt,
    };
    next.staging.push(stagedItem);
    undo.stagedAddedIds.push(stagedItem.id);
    staged += 1;
  }

  /* ---------- 上限 200：按 capturedAt 升序丢最旧 ---------- */
  if (next.staging.length > STAGING_LIMIT) {
    const sorted = [...next.staging].sort((a, b) => timeOf(a.capturedAt) - timeOf(b.capturedAt));
    const overflow = next.staging.length - STAGING_LIMIT;
    const dropIds = new Set(sorted.slice(0, overflow).map((item) => item.id));
    next.staging = next.staging.filter((item) => !dropIds.has(item.id));
    discarded = overflow;
  }

  return { db: next, undo, written, staged, discarded };
}

function platformLabelOf(platform: PlatformId): string {
  switch (platform) {
    case 'boss':
      return 'BOSS';
    case 'shixiseng':
      return '实习僧';
    case 'nowcoder':
      return '牛客';
    default:
      return '通用表格';
  }
}

/* ============================== 撤销 ============================== */

/**
 * 撤销一次同步（供 App.mutate 调用；纯函数，便于单测）。
 * 整条替换 before 快照 = 逐字段 diff 为空，这是可以自动化断言的验收口径。
 */
export function revertSync(draft: DB, undo: SyncUndo): void {
  // 1. notes 按 id 精确删除（绝不过滤 applicationId）
  draft.notes = draft.notes.filter((note) => !undo.noteIds.includes(note.id));

  // 2. 投递逐条还原
  for (const snap of undo.apps) {
    if (snap.before === null) {
      draft.applications = draft.applications.filter((app) => app.id !== snap.appId);
      draft.notes = draft.notes.filter((note) => note.applicationId !== snap.appId);
    } else {
      const index = draft.applications.findIndex((app) => app.id === snap.appId);
      if (index >= 0) draft.applications[index] = snap.before;
    }
  }

  // 3. 本次新建的公司：只有在已无投递引用时才删
  for (const companyId of undo.createdCompanyIds) {
    if (!draft.applications.some((app) => app.companyId === companyId)) {
      draft.companies = draft.companies.filter((company) => company.id !== companyId);
    }
  }

  // 4. 暂存区：先删本次新增的，再把用户处理掉的放回
  draft.staging = draft.staging.filter((item) => !undo.stagedAddedIds.includes(item.id));
  for (const { item } of undo.stagedRemoved) {
    if (!draft.staging.some((existing) => existing.id === item.id)) draft.staging.push(item);
  }
}

/** 给 UI 用：把一行的人话解释拼起来（避免组件里各写一遍） */
export function rowSummaryText(row: PlannedRow): string {
  if (row.kind === 'new') return `新增 · ${row.record.companyName}${row.record.jobTitle ? ` · ${row.record.jobTitle}` : ''}`;
  if (row.kind === 'staged') return row.warnings[0] ?? '待归类';
  if (row.kind === 'conflict') {
    const local = row.conflict ? STATUS_LABEL[row.conflict.local] : '—';
    const platform = row.conflict ? STATUS_LABEL[row.conflict.platform] : '—';
    return `${local} → ${platform}`;
  }
  const statusChange = row.changes.find((change) => change.field === 'status');
  if (statusChange && row.conflict === undefined && statusChange.from && statusChange.to) {
    return `${STATUS_LABEL[statusChange.from as Status]} → ${STATUS_LABEL[statusChange.to as Status]}`;
  }
  if (row.changes.length > 0) return `补全：${row.changes.map((change) => fieldLabel(change.field)).join('、')}`;
  return '无变化';
}

/** 字段中文名（预览表用） */
export function fieldLabel(field: string): string {
  const map: Record<string, string> = {
    status: '状态',
    statusChangedAt: '状态变更时间',
    lastActivityAt: '最后联系',
    appliedAt: '投递日期',
    jobTitle: '岗位名',
    jdUrl: 'JD 链接',
    city: '城市',
    salaryText: '薪资',
    channel: '渠道',
  };
  return map[field] ?? field;
}

export { TITLE_SIMILARITY };
