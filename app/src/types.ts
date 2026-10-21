/**
 * 全局数据模型（schema v2）。
 * 字段统一英文小驼峰；时间统一 ISO 8601 字符串；纯日期用 YYYY-MM-DD。
 *
 * 注意：本文件末尾 ↓ 有一个 `import type { NormalizedRecord }` 指向 adapters/types.ts，
 * 而 adapters/types.ts 又反向引用本文件的 PlatformId —— 这是一条**类型层循环**，
 * 靠 `import type`（编译后完全擦除、isolatedModules 下安全）打破。
 * **不要把它改成 `import {}`**，否则单文件打包后会出现 undefined。
 */

import type { NormalizedRecord } from './adapters/types';

/** 九种投递状态（终态：onboarded / rejected / dropped） */
export type Status =
  | 'wishlist'
  | 'applied'
  | 'chatting'
  | 'scheduled'
  | 'interviewing'
  | 'offer'
  | 'onboarded'
  | 'rejected'
  | 'dropped';

/** 实习类型：日常 / 暑期 / 校招 */
export type JobType = 'daily' | 'summer' | 'fulltime';

/** 投递渠道 */
export type Channel = 'boss' | 'shixiseng' | 'nowcoder' | 'liepin' | 'referral' | 'official' | 'other';

/** 面试形式 */
export type InterviewFormat = 'onsite' | 'video' | 'phone';

/** 面试结果 */
export type InterviewResult = 'pending' | 'passed' | 'failed' | 'cancelled';

/**
 * 时间线条目类型。v1 → v2 唯一枚举扩张：5 → 6（加 'sync'）。
 * 扩张后必须同步：storage 的 allowedNoteTypes、rules 的 NOTE_TYPE_LABEL。
 */
export type NoteType = 'chat' | 'interview' | 'followup' | 'system' | 'memo' | 'sync';

/** 平台标识：只增不改，等同一个稳定命名空间 */
export type PlatformId = 'boss' | 'shixiseng' | 'nowcoder' | 'liepin' | 'custom';

/** 公司档案 */
export interface Company {
  id: string;
  name: string;
  shortName?: string;
  industry?: string;
  city?: string;
  referrer?: string;
  impression?: string;
  createdAt: string;
}

/** 同步元信息。**平台独占，用户不可见不可编辑** */
export interface SyncMeta {
  platform: PlatformId;
  /** 平台侧稳定 id；粘贴通道通常拿不到（纯文本无 href） */
  externalId?: string;
  /**
   * 写入时算好的去重快照：`${normalizeCompanyName(name)}|${normalizeJobTitle(title)}`
   * 目的：用户事后改 jobTitle 后，下一次同步仍能命中同一条（D-08）
   * 失效条件：NORMALIZE_VERSION 变更 —— 命中前必须校验 matchKeyVersion
   */
  matchKey?: string;
  matchKeyVersion?: number;
  /** 平台原文状态，永远保留原样，便于用户核对与 overrides 调试 */
  platformStatusRaw?: string;
  /** 平台给的最后联系时间（ISO）。**绝不等于抓取时刻** */
  lastContactAt?: string;
  /** 本次写入时间（心跳）。**不参与沉默计算** */
  lastSyncedAt?: string;
}

/** 同步可写字段白名单（ownership 表的键） */
export type SyncableField =
  | 'status'
  | 'statusChangedAt'
  | 'lastActivityAt'
  | 'appliedAt'
  | 'jobTitle'
  | 'jdUrl'
  | 'city'
  | 'salaryText'
  | 'channel';

/** 用户手改过哪些字段（只记被改过的，用来做「默认不覆盖」判定） */
export type UserEditedMap = Partial<Record<SyncableField, string>>;

/** 一次投递 = 一条管线 */
export interface Application {
  id: string;
  companyId: string;
  jobTitle: string;
  /** 默认 'daily' */
  jobType?: JobType;
  city?: string;
  channel?: Channel;
  /** 投递日期 YYYY-MM-DD */
  appliedAt?: string;
  /** 默认 'wishlist' */
  status: Status;
  /** 状态最后变更时间，ISO */
  statusChangedAt: string;
  /** 沉默计算基准（派生但落库，便于排序），ISO */
  lastActivityAt: string;
  jdUrl?: string;
  resumeVersion?: string;
  salaryText?: string;
  daysPerWeek?: number;
  durationMonths?: number;
  /** 覆盖全局沉默阈值（天） */
  silenceOverride?: number | null;
  /** 挂在第几轮（status=rejected 时有意义） */
  rejectedAtRound?: number | null;
  rejectReason?: string;
  /** 用户自己定的下次动作时间（YYYY-MM-DD） */
  nextActionAt?: string | null;
  /**
   * 硬性截止时间（YYYY-MM-DD）。投递截止、Offer 回复截止都记这里。
   *
   * ★ 三态语义（v0.3 起的产品约定，git 历史见 CHANGELOG 0.3.0）：
   *   undefined = 没设置 → 继承上层（季节 / 全局默认）
   *   null      = 显式关闭 → 上层就算有截止，这条也不跟
   *   字符串    = 覆盖
   * 为什么不能用 `a ?? b` 收口：`??` 把 null 与 undefined 合并成一支，
   * 而这两者的业务含义正好相反（「跟随」与「明确不跟」）。校验必须走 `asTriStateDate()`。
   */
  deadlineAt?: string | null;
  /**
   * 静音到期时间（ISO 8601）。
   * 语义：在 `mutedUntil` 之前，这条不进入「今日必做」（用户已经知道、只是现在做不了）。
   * 列表页的沉默天数与红色标记**不受影响** —— 静音是「别催我」，不是「当它不存在」。
   */
  mutedUntil?: string | null;
  /** 心动程度 1-3 星 */
  priority?: 1 | 2 | 3;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  /** v2：同步元信息 */
  sync?: SyncMeta;
  /** v2：用户手改时间戳，只记被改过的字段 */
  userEditedAt?: UserEditedMap;
  /**
   * v0.5：软删除时间（ISO）。有值 = 在回收站里，不是真删。
   *
   * ★ 语义约定（后续不可破坏）：
   *   - 所有视图默认看不到它 —— 过滤发生在 App 构造 `api.db` 的那一处，
   *     不在每个组件里各判一次（40+ 个消费点，漏一个就是「删了还能看见」）。
   *   - 删除时把它的面试/备注一并「藏起来」，靠父投递的 deletedAt 推导，不额外落标记；
   *     否则恢复时会出现「投递回来了、面试没回来」的半残状态。
   *   - 留满 30 天才真删；第 27 天在设置页提示一次。清理由 sweepTrash 在启动时做。
   *   - 与 `⌘Z` 撤销是两套东西：撤销是「刚才那一下」的栈，回收站是「30 天内任何时候」的兜底。
   *     所以删除既要进撤销栈，也要进回收站。
   */
  deletedAt?: string | null;
}

/** 面试场次 */
export interface Interview {
  id: string;
  applicationId: string;
  /** 第几轮，从 1 开始 */
  round: number;
  totalRounds?: number | null;
  /** 面试时间，ISO */
  scheduledAt: string;
  durationMin?: number;
  format: InterviewFormat;
  locationOrLink?: string;
  interviewer?: string;
  prepChecklist?: { id: string; text: string; done: boolean }[];
  result: InterviewResult;
  notes?: string;
}

/**
 * 日历上的通用日程（v0.4）：课、组会、急事，什么都能标。
 * - weekly=true  → 每周固定（课表导入的课），配合 weekday（ISO 1-7）
 * - weekly=false → 某一天的事，配合 date（YYYY-MM-DD）
 * 冲突检测把面试和日程放在同一个池子里两两比对。
 *
 * v0.6（schemaVersion 3）additive 扩展：kind 加 interview / deadline，
 * 新增 applicationId / color / notes 三个可选字段。
 * **没有引入第二套时间表达** —— 仍然是「哪天（weekly+weekday / date）+ 几点（start/end）」，
 * 因为 findConflicts / findEventConflicts / eventsOnDate 都按这个结构写好了。
 */
export type CalendarEventKind = 'course' | 'personal' | 'interview' | 'deadline';

export interface CalendarEvent {
  id: string;
  title: string;
  kind: CalendarEventKind;
  /** HH:mm（24 小时制） */
  start: string;
  end: string;
  weekly: boolean;
  weekday?: number;
  date?: string;
  /** v0.6：关联投递（可空 —— 课、私事都不挂投递） */
  applicationId?: string;
  /** v0.6：自定义颜色（#rrggbb；缺省按 kind 取默认色） */
  color?: string;
  /** v0.6：备注 */
  notes?: string;
}

/** v2：note 的来源追踪（只有 type==='sync' 才有） */export interface NoteSource {
  platform: PlatformId;
  externalId?: string;
  /** 本次抓取时刻，仅用于审计，不参与任何派生 */
  capturedAt: string;
  /** 平台给的业务时间，参与派生 */
  platformTime?: string;
}

/** 时间线条目 */
export interface Note {
  id: string;
  applicationId: string;
  type: NoteType;
  content: string;
  /** 系统自动生成（true 时不可编辑） */
  auto?: boolean;
  /** 发生时间，参与沉默计算，ISO */
  touchedAt: string;
  source?: NoteSource;
}

/** v2：同步设置 */
export interface SyncSettings {
  /** 风险确认时刻；一旦有值，永不再弹窗（PRD §B.2） */
  riskAckAt?: string;
  defaultPlatform: PlatformId;
  /** 平台原文案 → 内部状态。null = 明确不映射。空对象时用内置 7 条规则 */
  statusMapOverrides: Record<string, Status | null>;
  /** 是否用平台时间刷新 lastActivityAt（默认 true） */
  autoRefreshActivity: boolean;
}

/** v2：迁移审计（写进 db 内部，便于导出备份时自查） */
export interface MigrationRecord {
  from: number;
  to: number;
  at: string;
  /** localStorage 里回滚点的 key */
  backupKey: string;
}

/** 全局设置 */
export interface AppSettings {
  schemaVersion: 3;
  warnAfterDays: number;
  staleAfterDays: number;
  interviewResultWaitDays: number;
  wishlistExpireDays: number;
  /** 当天面试几点之后才开始提示「记一下结果」（默认 20 点） */
  resultPromptHour: number;
  /** Offer 发出后等多少天算「沉默」（默认 7）。offer 与投递的节奏完全不同，不能共用一个阈值 */
  offerSilenceDays: number;
  /** 截止日期提前几天开始提醒（默认 3） */
  deadlineWarnDays: number;
  /** 今日行动预算：超过这个条数折叠成「还有 N 件」（默认 5，0 表示不折叠） */
  dailyActionBudget: number;
  /** 渠道系数：内推 3 / 官网 2 / 其余 1 */
  channelFactor: Record<Channel, number>;
  weeklyApplyGoal: number;
  /**
   * 每周固定课程时间段（v0.2 引入，**v0.4 已废弃**）。
   * 读取旧库时一次性迁移进 `db.events`（kind='course', weekly=true）然后清空。
   * 保留字段只为老备份导入不炸，代码里不要再往这里写东西。
   * @deprecated 用 db.events
   */
  courseSlots: { weekday: number; start: string; end: string; name: string }[];
  defaultResumeVersion?: string;
  /** v2 新增：同步设置 */
  sync: SyncSettings;
  /** v0.6 新增：备份提醒间隔天数（3 / 7 / 14；0 = 不提醒） */
  backupReminderDays: number;
  /** v0.6 新增：本地文件联动（File System Access）设置 */
  fileLink: FileLinkSettings;
  /** v0.6 新增：导出加密开关（默认关闭；用户主动开启） */
  encryption: EncryptionSettings;
  /** v2 新增：上一次迁移审计 */
  lastMigration?: MigrationRecord;
}

/**
 * 导出加密设置（v0.6 / D10）。
 *
 * ★ **这里永远不会出现口令、密钥、salt 或 IV 中的任何一个。**
 *   口令只活在内存里（React state），关掉标签页就没有了；
 *   密钥由 PBKDF2 每次从口令 + 文件里的 salt 现场派生，不落库。
 *   如果哪天有人想在这里加一个 `keyHash` 之类的东西，那就等于把一个
 *   离线可爆破的验证器写进了备份文件 —— 明确禁止。
 *
 * `enabled` 记录的是「用户希望导出时加密」这个意图。
 * 真正的开关状态还要配合「本次会话里是否已经输入过口令」，
 * 二者缺一就退回明文导出（并在导出时明确提示，绝不静默降级）。
 */
export interface EncryptionSettings {
  enabled: boolean;
  /** 上一次启用 / 关闭的时间（ISO），设置页展示用 */
  changedAt?: string;
}

/**
 * 本地文件联动设置（v0.6 / D8）。
 *
 * 刻意**不存**任何文件句柄或密钥 —— 句柄要放 IndexedDB（structured clone），
 * 这一点由 `lib/fileLink/handleStore.ts` 单独负责；settings 里只放用户层面的开关。
 * 这样导出的 JSON 里不会混进句柄，也不会把「这台机器连了哪个文件」带到别的设备。
 */
export interface FileLinkSettings {
  /** 用户是否开启了文件联动（默认 false） */
  enabled: boolean;
  /** 只读锁定：权限丢失 / 冲突未解决时置 true，UI 顶部横幅提示 */
  readOnly: boolean;
  /** 上次成功写入的时间（ISO），用于状态指示器 */
  lastSyncedAt?: string;
  /** 上次冲突副本的文件名，用于「去对比」入口 */
  lastConflictFile?: string;
}

/* ===================== v2 三个新实体 ===================== */

export type ExperienceResult = 'passed' | 'failed' | 'pending' | 'unknown';
export type ExperienceSource = 'self' | 'community';

/** 一场面试 = 一个壳。companyName/jobTitle 是**冗余快照**（投递被删了面经还在） */
export interface InterviewExperience {
  id: string;
  /** 可空：笔试原题、群面、「朋友的题」、社区面经天然无本地投递（PRD §C.1） */
  applicationId?: string | null;
  companyName: string;
  jobTitle?: string;
  round?: number | null;
  /** YYYY-MM-DD（纯日期，不带时间） */
  interviewDate: string;
  result: ExperienceResult;
  /** ≤3000 字（PRD §D.4 防护） */
  overallNote?: string;
  source: ExperienceSource;
  /** 社区导入时的来源文件名，可审计；source==='self' 时不存在 */
  originFile?: string;
  createdAt: string;
  updatedAt: string;
}

export type QuestionCategory = 'algo' | 'concept' | 'project' | 'behavior' | 'reverse' | 'hr';
export type Mastery = 0 | 1 | 2;
export type RootCause = 'conceptGap' | 'forgot' | 'nervous' | 'misread' | 'neverSeen';

/** 一道题 = 一张复习卡 */
export interface Question {
  id: string;
  experienceId: string;
  /** null = 没标（「没标」约等于「心里没底」，排序时按 0 处理） */
  category: QuestionCategory | null;
  difficulty: 1 | 2 | 3;
  /** 题干 ≤2000 字 */
  text: string;
  /** 我当时怎么答的 ≤5000 字 —— 面经最值钱的字段 */
  myAnswer?: string;
  mastery: Mastery;
  rootCause?: RootCause;
  /** 下次怎么改，一句话 */
  nextTime?: string;
  tags: string[];
  /** 派生：YYYY-MM-DD。见 lib/interview.ts deriveInitialNextReviewAt */
  nextReviewAt?: string;
  reviewCount: number;
  lastReviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type StagedReason = 'unmapped' | 'ambiguous' | 'conflict' | 'unparsed';

/** 暂存区（上限 200，超出丢最旧并提示） */
export interface StagedSyncItem {
  id: string;
  platform: PlatformId;
  externalId?: string;
  /** 原始解析结果（含逐字段置信度）；`reason === 'unparsed'` 时公司名可能为空 */
  parsed: NormalizedRecord;
  /** conflict / ambiguous 时的候选本地投递 */
  candidateAppId?: string;
  reason: StagedReason;
  /** 状态映射失败时的平台原文，供 UI 直接展示 */
  platformStatusRaw?: string;
  /** `reason === 'unparsed'` 时的原始片段（≤500 字），让用户看得见丢了什么 */
  rawSnippet?: string;
  /** `reason === 'unparsed'` 时的失败原因（「这一行没有公司名」） */
  reasonText?: string;
  capturedAt: string;
}

/** localStorage 里存的整份数据库 */
export interface DB {
  settings: AppSettings;
  companies: Company[];
  applications: Application[];
  interviews: Interview[];
  notes: Note[];
  /* v2 三个新表，平铺顶层（PRD §D.1） */
  experiences: InterviewExperience[];
  questions: Question[];
  staging: StagedSyncItem[];
  /** v0.4：日历上的通用日程（课表导入的课 + 手动记的事） */
  events: CalendarEvent[];
}
