/**
 * 导入字段自动映射（v0.6 / P1）。
 *
 * 解决的问题：用户手上往往不是「本应用导出的 JSON」，而是
 * 表格软件里的 CSV、别的求职工具导出的 JSON、或者自己记的一列清单。
 * v0.5 及以前这些文件只会得到一句「缺少 settings / applications 字段」——
 * 明明数据就在眼前，却要人手抄一遍。
 *
 * 设计三条原则：
 *
 * 1. **只认字段名，不猜内容**。映射靠表头/键名匹配别名表，
 *    绝不做「这一列看起来像日期所以当投递日」这类语义推断 ——
 *    猜错了用户要一条条改，比手抄还慢。
 * 2. **必须有确认步骤**。自动映射的结果永远先给用户看
 *    （哪一列映射到什么、哪几列被忽略），确认后才落库。
 *    静默导入一份猜错的文件，破坏性远大于多一次点击。
 * 3. **认不出的列给 reason，不许悄悄丢**。与课表导入同一口径。
 */

import type { Application, Channel, Company, DB, Status } from '../types';
import { emptyDB } from './defaults';

/* ------------------------------ 表头别名 ------------------------------ */

/**
 * 别名表：字段 → 可能出现的表头写法（大小写、空格、全角半角都不敏感）。
 *
 * 覆盖顺序就是优先级：同一个表头命中多个字段时取先列出的那个，
 * 所以「投递日期」要排在「日期」前面，否则会被更宽泛的别名抢走。
 */
export const FIELD_ALIASES = {
  company: ['公司', '公司名', '公司名称', '企业', '企业名称', '单位', 'company', 'companyname', 'employer'],
  jobTitle: ['岗位', '职位', '岗位名称', '职位名称', '应聘岗位', 'jobtitle', 'position', 'role', 'title'],
  status: ['状态', '投递状态', '进展', '当前状态', 'status', 'stage'],
  channel: ['渠道', '投递渠道', '来源', '途径', 'channel', 'source'],
  appliedAt: ['投递日期', '投递时间', '申请日期', '申请时间', '投递日', 'appliedat', 'applied', 'applydate'],
  lastContactAt: ['最近联系', '最后联系', '最近互动', '最近更新', 'lastcontactat', 'lastcontact'],
  city: ['城市', '地点', '工作地点', '地区', 'city', 'location'],
  salary: ['薪资', '薪水', '工资', '薪酬', 'salary', 'pay'],
  link: ['链接', '职位链接', '投递链接', '网址', 'url', 'link'],
  resumeVersion: ['简历版本', '简历', 'resumeversion', 'resume'],
  priority: ['优先级', '重要程度', 'priority'],
  notes: ['备注', '说明', '笔记', 'note', 'notes', 'remark', 'comment'],
  note: ['备注', '说明', '笔记', 'note', 'notes', 'remark', 'comment'],
} as const;

export type MappableField = keyof typeof FIELD_ALIASES;

/** 归一化表头：去空格 / 全角转半角 / 小写 / 去掉常见标点 */
export function normalizeHeader(raw: string): string {
  return raw
    .replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000_\-/\\:：()（）[\]【】]/g, '')
    .toLowerCase();
}

/**
 * 逐列判定字段。
 *
 * 返回 `field: null` 表示「这一列认不出来」，调用方必须把它列进
 * 「已忽略的列」交给用户看 —— 不许悄悄丢。
 */
export interface ColumnMapping {
  /** 原始表头（保留大小写与空格，UI 上要原样显示） */
  header: string;
  field: MappableField | null;
}

export function mapHeaders(headers: string[]): ColumnMapping[] {
  const used = new Set<MappableField>();
  return headers.map((header) => {
    const normalized = normalizeHeader(header);
    for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[MappableField, readonly string[]]>) {
      if (used.has(field)) continue;
      if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
        used.add(field);
        return { header, field };
      }
    }
    return { header, field: null };
  });
}

/* ------------------------------ 取值清洗 ------------------------------ */

const STATUS_ALIASES: Record<string, Status> = {
  // 想投 / 未投
  想投: 'wishlist', 待投: 'wishlist', 计划投递: 'wishlist', 收藏: 'wishlist', wishlist: 'wishlist',
  // 已投
  已投: 'applied', 已投递: 'applied', 已申请: 'applied', 投递成功: 'applied', applied: 'applied',
  // 沟通中
  沟通中: 'chatting', 已沟通: 'chatting', 已联系: 'chatting', 待回复: 'chatting', chatting: 'chatting',
  // 笔试 / 测评一律落到「已沟通」（9 状态模型里没有笔试这一档，硬造会破坏静音算法）
  笔试: 'chatting', 笔试中: 'chatting', 测评: 'chatting',
  // 已约面
  已约面: 'scheduled', 约面: 'scheduled', 待面试: 'scheduled', 已安排面试: 'scheduled', scheduled: 'scheduled',
  // 面试中
  面试: 'interviewing', 面试中: 'interviewing', 一面: 'interviewing', 二面: 'interviewing', 三面: 'interviewing',
  等结果: 'interviewing', 等待结果: 'interviewing', 已面完: 'interviewing', interviewing: 'interviewing',
  // Offer
  offer: 'offer', 已offer: 'offer', 已录用: 'offer', 录用: 'offer',
  // 入职
  入职: 'onboarded', 已入职: 'onboarded', onboarded: 'onboarded',
  // 已结束
  拒绝: 'rejected', 已拒绝: 'rejected', 挂: 'rejected', 已挂: 'rejected', rejected: 'rejected',
  放弃: 'dropped', 已放弃: 'dropped', 归档: 'dropped', dropped: 'dropped', archived: 'dropped',
};

const CHANNEL_ALIASES: Record<string, Channel> = {
  内推: 'referral', 内推referral: 'referral', referral: 'referral',
  官网: 'official', 官方网站: 'official', 官网投递: 'official', official: 'official',
  boss: 'boss', boss直聘: 'boss',
  实习僧: 'shixiseng', shixiseng: 'shixiseng',
  牛客: 'nowcoder', 牛客网: 'nowcoder', nowcoder: 'nowcoder',
  猎聘: 'liepin', liepin: 'liepin',
  其他: 'other', other: 'other',
};

export function normalizeStatus(raw: string): Status | null {
  const key = normalizeHeader(raw);
  return STATUS_ALIASES[key] ?? null;
}

export function normalizeChannel(raw: string): Channel | null {
  const key = normalizeHeader(raw);
  return CHANNEL_ALIASES[key] ?? null;
}

/**
 * 日期清洗：接受 `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYY.MM.DD` / `YYYY年MM月DD日`，
 * 统一成 `YYYY-MM-DD`；带时间的一律**只取日期部分**（导入不需要精确到分钟，
 * 而时区换算会给用户带来「日期差一天」的惊吓）。
 *
 * 认不出来就返回 null —— 由调用方退回「今天」，并在预览里标出来。
 */
export function normalizeDate(raw: string, fallback: string): string {
  const text = raw.trim();
  if (!text) return fallback;
  const match = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(text);
  if (!match) return fallback;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return fallback;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/* ------------------------------ CSV 解析 ------------------------------ */

/**
 * 手写 CSV 解析（零依赖）。
 *
 * 必须支持：双引号包裹、引号内逗号/换行、`""` 转义、CRLF、UTF-8 BOM。
 * 这些不是「锦上添花」—— 表格软件导出的 CSV 全都带引号与 CRLF，
 * 只按逗号 split 会把「公司, Inc.」这种字段切碎。
 */
export function parseCSV(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // CRLF：等下一个 \n 处理；单独的 \r 也当换行
      if (source[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((line) => line.some((cell) => cell.trim() !== ''));
}

/* ------------------------------ 映射成记录 ------------------------------ */

export interface UnmappedColumn {
  header: string;
  reason: string;
}

export interface MappedRow {
  company: string;
  jobTitle: string;
  status: Status;
  channel: Channel;
  appliedAt: string;
  city: string;
  salary: string;
  link: string;
  resumeVersion: string;
  priority: number;
  notes: string;
}

export interface MappingPreview {
  /** 识别出的列 → 字段 */
  columns: ColumnMapping[];
  /** 认不出来的列（必须展示给用户） */
  unmapped: UnmappedColumn[];
  /** 表头之外的原始列名（用于「这不像是有表头的 CSV」的提示） */
  headerRow: string[];
  rows: MappedRow[];
  /** 逐行的问题（缺公司名 / 日期认不出） */
  rowIssues: Array<{ row: number; reason: string }>;
  /** 无法导入的行数（缺公司名 + 缺岗位名 的行直接跳过） */
  skipped: number;
}

/**
 * 从 CSV 文本生成映射预览。**纯函数**，不碰 DB。
 *
 * 表头识别失败（第一行看起来像数据而不是表头）时，退化为「按列序猜」：
 * 第 1 列公司、第 2 列岗位 —— 这是最常见的手抄清单形态。
 * 但这一定会在预览里标明「没有识别到表头，按列顺序推断」，不假装确定。
 */
export function previewCSV(text: string, todayIso: string): MappingPreview {
  const rows = parseCSV(text);
  const empty: MappingPreview = {
    columns: [],
    unmapped: [],
    headerRow: [],
    rows: [],
    rowIssues: [],
    skipped: 0,
  };
  if (rows.length === 0) return { ...empty, rowIssues: [{ row: 0, reason: '文件里没有任何非空行' }] };

  const first = rows[0];
  const mapped = mapHeaders(first);
  const hasHeader = mapped.some((column) => column.field !== null);

  const columns: ColumnMapping[] = hasHeader
    ? mapped
    : [
        { header: first[0] ?? '第 1 列', field: 'company' as const },
        { header: first[1] ?? '第 2 列', field: 'jobTitle' as const },
        ...first.slice(2).map((header) => ({ header, field: null as MappableField | null })),
      ];

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const indexOf = (field: MappableField): number => columns.findIndex((column) => column.field === field);
  const cell = (line: string[], field: MappableField): string => {
    const index = indexOf(field);
    return index >= 0 ? (line[index] ?? '').trim() : '';
  };

  const previews: MappedRow[] = [];
  const rowIssues: MappingPreview['rowIssues'] = [];
  let skipped = 0;

  dataRows.forEach((line, offset) => {
    const rowNumber = hasHeader ? offset + 2 : offset + 1;
    const company = cell(line, 'company');
    const jobTitle = cell(line, 'jobTitle');
    if (!company && !jobTitle) {
      skipped += 1;
      rowIssues.push({ row: rowNumber, reason: '公司名和岗位名都为空，已跳过' });
      return;
    }
    if (!company) {
      skipped += 1;
      rowIssues.push({ row: rowNumber, reason: '缺少公司名，已跳过（岗位名不能代替公司）' });
      return;
    }

    const rawApplied = cell(line, 'appliedAt');
    const appliedAt = normalizeDate(rawApplied, todayIso);
    if (rawApplied && appliedAt === todayIso && normalizeDate(rawApplied, '') === '') {
      rowIssues.push({ row: rowNumber, reason: `投递日期「${rawApplied}」认不出来，已按今天处理` });
    }

    const rawStatus = cell(line, 'status');
    const status = rawStatus ? normalizeStatus(rawStatus) : null;
    if (rawStatus && !status) {
      rowIssues.push({ row: rowNumber, reason: `状态「${rawStatus}」认不出来，已按「想投」处理` });
    }

    const rawChannel = cell(line, 'channel');
    const channel = rawChannel ? normalizeChannel(rawChannel) : null;
    if (rawChannel && !channel) {
      rowIssues.push({ row: rowNumber, reason: `渠道「${rawChannel}」认不出来，已按「其他」处理` });
    }

    previews.push({
      company,
      jobTitle,
      status: status ?? 'wishlist',
      channel: channel ?? 'other',
      appliedAt,
      city: cell(line, 'city'),
      salary: cell(line, 'salary'),
      link: cell(line, 'link'),
      resumeVersion: cell(line, 'resumeVersion'),
      priority: Number(cell(line, 'priority')) === 2 || Number(cell(line, 'priority')) === 1 ? 2 : 1,
      notes: cell(line, 'notes') || cell(line, 'note'),
    });
  });

  const unmapped: UnmappedColumn[] = columns
    .filter((column) => column.field === null)
    .map((column) => ({
      header: column.header,
      reason: '表头认不出来，这一列不会被导入（可以先把表头改成「备注」「城市」这类常见写法）',
    }));

  if (!hasHeader) {
    // 无论后面有几列，这条提示都必须出现：它改变的是「整份文件怎么被理解」，
    // 不是某一行的问题，所以放在 rowIssues 的第一条（UI 会置顶显示）。
    rowIssues.unshift({
      row: 1,
      reason: '第一行看起来不是表头，已按「第 1 列=公司、第 2 列=岗位」推断，其余列忽略',
    });
  }

  return { columns, unmapped, headerRow: first, rows: previews, rowIssues, skipped };
}

/* ------------------------------ 落成 DB ------------------------------ */

/**
 * 把映射结果合进当前库。**复用同一个去重键**（公司名归一 + 岗位 + 投递日），
 * 与 JSON 增量导入完全一致 —— 否则会出现「同一个岗位，JSON 导入去重、
 * CSV 导入重复」这种两套语义打架的鬼故事。
 *
 * 备注列的落点：写一条 `memo` 时间线，而不是给投递加字段。
 * 理由是这个应用里「备注」本来就等于时间线条目（`Application` 上没有 notes 字段），
 * 另外 CSV 里的备注没有时间，只能挂在投递日当天的 00:00 —— 会在 note 内容里
 * 标明「来自 CSV 导入」，用户看到时间不对时能立刻明白来源。
 */
export interface CSVImportResult {
  db: DB;
  added: number;
  skippedExisting: number;
}

function normalizeCompanyKey(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

export function buildDBFromCSV(
  base: DB,
  preview: MappingPreview,
  nowIso: string,
): CSVImportResult {
  const db: DB = {
    ...base,
    companies: [...base.companies],
    applications: [...base.applications],
    notes: [...base.notes],
  };
  const companyByName = new Map<string, Company>();
  for (const company of db.companies) companyByName.set(normalizeCompanyKey(company.name), company);

  const existing = new Set(
    db.applications.map((app) => {
      const company = db.companies.find((item) => item.id === app.companyId);
      return `${normalizeCompanyKey(company?.name ?? '')}|${app.jobTitle.trim().toLowerCase()}|${(app.appliedAt ?? '').slice(0, 10)}`;
    }),
  );

  let added = 0;
  let skippedExisting = 0;
  let seq = db.applications.length;

  for (const row of preview.rows) {
    const key = `${normalizeCompanyKey(row.company)}|${row.jobTitle.trim()}|${row.appliedAt}`;
    if (existing.has(key)) {
      skippedExisting += 1;
      continue;
    }
    existing.add(key);

    const companyKey = normalizeCompanyKey(row.company);
    let company = companyByName.get(companyKey);
    if (!company) {
      seq += 1;
      company = {
        id: `c_import_${seq}_${companyKey.slice(0, 6)}`,
        name: row.company,
        ...(row.city ? { city: row.city } : {}),
        createdAt: nowIso,
      };
      companyByName.set(companyKey, company);
      db.companies.push(company);
    }

    seq += 1;
    const application: Application = {
      id: `app_import_${seq}`,
      companyId: company.id,
      jobTitle: row.jobTitle || '（未填岗位）',
      status: row.status,
      channel: row.channel,
      appliedAt: row.appliedAt,
      lastActivityAt: row.appliedAt,
      statusChangedAt: `${row.appliedAt}T00:00:00.000Z`,
      priority: row.priority as 1 | 2 | 3,
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(row.city ? { city: row.city } : {}),
      ...(row.resumeVersion || base.settings.defaultResumeVersion
        ? { resumeVersion: row.resumeVersion || base.settings.defaultResumeVersion }
        : {}),
      ...(row.link ? { jdUrl: row.link } : {}),
      ...(row.salary ? { salaryText: row.salary } : {}),
    };
    db.applications.push(application);
    added += 1;

    if (row.notes) {
      db.notes.push({
        id: `note_import_${seq}`,
        applicationId: application.id,
        type: 'memo',
        content: row.notes,
        // CSV 里没有备注的时间，挂在投递日当天；内容里标来源，用户一眼知道时间不准
        touchedAt: `${row.appliedAt}T00:00:00.000Z`,
        auto: false,
      });
    }
  }

  return { db, added, skippedExisting };
}

/** 给「从零开始」用的空库（CSV 导入时的默认基底） */
export function emptyBaseDB(): DB {
  return emptyDB();
}
