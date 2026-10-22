/**
 * 视图与「操作 API」的类型契约。
 * App.tsx 负责实现，视图组件只依赖这里的类型 —— 避免组件之间互相 import 造成循环依赖。
 */

import type {
  AppSettings,
  Application,
  CalendarEvent,
  Company,
  DB,
  ExperienceResult,
  Interview,
  InterviewExperience,
  InterviewFormat,
  InterviewKind,
  Mastery,
  NoteType,
  PlatformId,
  Question,
  Status,
} from '../types';
import type { MergePlan, PlannedRow } from './sync/types';
import type { FileLinkCapability } from './fileLink/handle';

export type ViewKey = 'today' | 'board' | 'list' | 'calendar' | 'insights';

export const VIEWS: Array<{ key: ViewKey; label: string; hint: string }> = [
  { key: 'today', label: '今日', hint: '1' },
  { key: 'board', label: '看板', hint: '2' },
  { key: 'list', label: '列表', hint: '3' },
  { key: 'calendar', label: '日历', hint: '4' },
  { key: 'insights', label: '复盘', hint: '5' },
];

/** 复盘内的二级 tab（PRD §E.1：不新增一级 tab） */
export type InsightsTab = 'data' | 'interview';

/** 二级 tab 与视图一起记忆（第二次按 5 不重置） */
export interface UIViewState {
  view: ViewKey;
  insightsTab: InsightsTab;
}

/** 新增日程（日历「记一件事」/ 课表导入共用） */
export interface NewCalendarEventInput {
  title: string;
  start: string;
  end: string;
  /** true = 每周固定（课），看 weekday；false = 某一天的事，看 date */
  weekly?: boolean;
  weekday?: number;
  date?: string;
  kind?: CalendarEvent['kind'];
}

/** 课表导入的一节课（courseImport.ts 的解析产物） */
export interface ParsedCourseInput {
  weekday: number;
  start: string;
  end: string;
  name: string;
}

/** 新增投递：只要求公司名 + 岗位名 */export interface NewApplicationInput {
  companyName: string;
  jobTitle: string;
  status?: Status;
  city?: string;
  channel?: Application['channel'];
  appliedAt?: string;
  resumeVersion?: string;
  salaryText?: string;
  daysPerWeek?: number;
  durationMonths?: number;
  jdUrl?: string;
  priority?: 1 | 2 | 3;
}

export interface NewInterviewInput {
  applicationId: string;
  /** v0.8 起允许 0（笔试记录，kind 固定 'written'） */
  round?: number;
  /** v0.8：面试类型；缺省 = 未标注 */
  kind?: InterviewKind;
  scheduledAt: string;
  format: InterviewFormat;
  durationMin?: number;
  locationOrLink?: string;
  interviewer?: string;
  result?: Interview['result'];
  notes?: string;
}

/** 拖拽落列后的 3 字段轻面板 */
export interface StatusChangeOpts {
  /** 发生时间（ISO），默认现在 */
  at?: string;
  /** 备注 */
  note?: string;
  /** 轮次（rejected 时写 rejectedAtRound） */
  round?: number;
  /**
   * v0.8 备注：面试段列的轮次/类型**不走**这里 —— DropPanel 直接调
   * `addInterview`（结构化写入），status 变更与面试记录保持两条独立 mutate，
   * 与「⌘Z 只回退状态、用户手写内容不丢」的既有撤销语义一致（共享知识 #7）。
   */
}

/** 快记的带入上下文（来自投递详情 / 今日待复盘卡片） */
export interface QuickNoteContext {
  applicationId?: string;
  companyName?: string;
  jobTitle?: string;
  round?: number;
  interviewDate?: string;
}

/** 新增面经：companyName + interviewDate 必填，其余可空 */
export interface NewExperienceInput {
  applicationId?: string | null;
  companyName: string;
  jobTitle?: string;
  round?: number | null;
  interviewDate: string;
  result: ExperienceResult;
  overallNote?: string;
  source?: InterviewExperience['source'];
  originFile?: string;
}

/** ① → ② 的结果 */
export type SyncPlanOutcome =
  | { ok: true; plan: MergePlan; adapterId: PlatformId; adapterStale: boolean }
  | { ok: false; error: string };

export interface AppApi {
  db: DB;
  now: Date;
  view: ViewKey;
  selectedId: string | null;
  highlightedId: string | null;

  setView: (view: ViewKey) => void;
  openDetail: (id: string) => void;
  closeDetail: () => void;
  /** 跳到看板并高亮某条投递 */
  focusApp: (id: string) => void;
  openNew: (initialStatus?: Status) => void;
  openSettings: () => void;
  toast: (text: string) => void;

  addApplication: (input: NewApplicationInput) => string;
  updateApplication: (id: string, patch: Partial<Application>) => void;
  changeStatus: (id: string, status: Status, opts?: StatusChangeOpts) => void;
  deleteApplication: (id: string) => void;
  /** v0.5 回收站：从回收站恢复（面试与沟通记录原样回来） */
  restoreApplication: (id: string) => void;
  /** v0.5 回收站：永久删除一条，不可撤销 */
  purgeApplication: (id: string) => void;
  /** v0.5 回收站：清空 */
  emptyTrash: () => void;
  /** v0.5 回收站：把到期时间再推 7 天 */
  extendTrash: (id: string) => void;

  addNote: (applicationId: string, type: NoteType, content: string, at?: string) => void;
  deleteNote: (noteId: string) => void;

  addInterview: (input: NewInterviewInput) => void;
  updateInterview: (id: string, patch: Partial<Interview>) => void;
  deleteInterview: (id: string) => void;

  updateCompany: (id: string, patch: Partial<Company>) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;

  loadSampleData: () => void;
  clearAllData: () => void;

  /* ---------------- 日历日程（v0.4） ---------------- */
  /** 手动记一件事 */
  addCalendarEvent: (input: NewCalendarEventInput) => void;
  deleteCalendarEvent: (id: string) => void;
  /** 导入课表：替换全部「每周固定的课」，保留手动记的事。返回导入节数 */
  importCourseEvents: (courses: ParsedCourseInput[]) => number;
  /** 完整备份（JSON，可无损往返 —— 这是唯一能「搬回本应用」的格式） */
  exportData: () => void;
  /** 投递表 CSV（单向导出，给 Excel / Numbers 看） */
  exportCsv: () => void;
  /** 面试日历 ICS（单向导出，导进系统日历） */
  exportIcs: () => void;
  importData: (file: File) => void;
  /**
   * 便携包（v0.5 / D5）：应用本体 + 当前数据打成一个 zip。
   * 与 `exportData` 的区别：那个只有数据，别人拿到还得先找到 index.html。
   */
  exportPortable: () => Promise<void>;
  /**
   * 存储用量与配额（v0.5）。localStorage 后端拿不到真实配额，
   * 只有 IndexedDB 后端才有值；返回 null 时 UI 不展示。
   */
  checkStorage: () => Promise<{ usage: number; quota: number; ratio: number } | null>;
  /** 当前存储后端名（localStorage / IndexedDB），用于设置页如实告知 */
  storageBackend: () => string;

  /* ---------------- 文件联动（v0.6 / D8） ---------------- */
  fileLink: {
    /** 能力探测结果；`full` 之外的一切都走手动导入导出 */
    capability: FileLinkCapability;
    /** 已连接的文件名（null = 没连） */
    fileName: string | null;
    /** 只读原因（null = 可写） */
    readOnlyMessage: string | null;
    /** 有没有一条中断的写入等着重放 */
    hasPending: boolean;
    busy: boolean;
    connect: () => Promise<void>;
    disconnect: () => void;
    retryPermission: () => Promise<void>;
    replayPending: () => Promise<void>;
    /** 只读三出口之一：下载当前库原文（不碰联动文件） */
    downloadRaw: () => void;
    /** 只读三出口之三：另存为新文件（并切换联动目标） */
    saveAs: () => Promise<void>;
    /** 开启 / 关闭导出加密；返回错误文案或 null */
    toggleEncryption: (enabled: boolean, password: string) => Promise<string | null>;
  };

  /* ---------------- 复盘二级 tab（v2） ---------------- */
  insightsTab: InsightsTab;
  setInsightsTab: (tab: InsightsTab) => void;

  /* ---------------- 同步（全部是动作，不是视图） ---------------- */
  syncOpen: boolean;
  openSync: () => void;
  closeSync: () => void;
  /** 最近一次解析出的计划（null = 还没解析） */
  syncPlan: MergePlan | null;
  /** 计划对应的平台与「适配器可能已失效」标记 */
  syncAdapterId: PlatformId | null;
  syncAdapterStale: boolean;
  /** ① → ②：对原始文本跑适配器 + 合并计划。返回计划供面板渲染 */
  planSync: (input: { text: string; platform?: PlatformId; capturedAt: string }) => SyncPlanOutcome;
  /** ④ 确认合并。rows 是用户最终勾选的行 */
  commitSync: (rows: PlannedRow[]) => void;
  /** 暂存区逐条处理。status 为 null = 忽略（丢弃） */
  resolveStaged: (stagedId: string, status: Status | null) => void;
  clearStaging: () => void;
  ackSyncRisk: () => void;

  /* ---------------- 面经 ---------------- */
  addExperience: (input: NewExperienceInput) => string;
  updateExperience: (id: string, patch: Partial<InterviewExperience>) => void;
  deleteExperience: (id: string) => void;
  /** 批量加题（快记用），返回实际写入条数 */
  addQuestions: (experienceId: string, texts: string[]) => number;
  updateQuestion: (id: string, patch: Partial<Question>) => void;
  deleteQuestion: (id: string) => void;
  /** 复习一次：reviewCount+1、lastReviewedAt、nextReviewAt 按新 mastery 重算 */
  reviewQuestion: (id: string, mastery: Mastery) => void;
  /** 快记浮层 */
  quickNote: QuickNoteContext | null;
  openQuickNote: (ctx?: QuickNoteContext) => void;
  closeQuickNote: () => void;
  exportExperienceMarkdown: (experiences: InterviewExperience[], opts: { desensitize: boolean }) => void;
  /** 社区题库导入（P1）：拖入/粘贴已下载的 .json */
  importCommunityFile: (file: File) => void;

  /*
   * v0.2 实现补充（架构 §2.7 未列，但 T05-6 要求详情抽屉里能直接「看已有 N 题」）：
   * 面经编辑器是一个跨视图浮层，状态必须在中枢，不能塞进某个视图组件里。
   */
  experienceEditorId: string | null;
  openExperience: (id: string) => void;
  closeExperience: () => void;

  /* ---------------- AI（v0.8 / T03；场景 UI 由 T05 消费） ---------------- */
  ai: {
    /** 就绪判定（baseURL + model 已配置）；false 时入口置灰 + 内联原因，不弹错误轰炸 */
    ready: boolean;
    readyReason: string | null;
    /** 接受勾选的建议：单次 mutate 写目标表 + 一个撤销点（⌘Z 整体回退） */
    acceptSuggestions: (ids: string[]) => void;
    /** 忽略勾选的建议（rejected，留 7 天后启动 sweep 清理） */
    rejectSuggestions: (ids: string[]) => void;
    /** 一键清空请求日志（日志本就不含原文，清空只为省空间） */
    clearRequestLog: () => void;
  };

  /** v0.8：插件宿主分组。T04 落 broker/sandbox 后补齐 —— 占位防止场景提前接线 */
  plugins: Record<string, never>;
}
