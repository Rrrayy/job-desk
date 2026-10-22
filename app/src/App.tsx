/**
 * App：唯一的状态中枢。
 * 所有写操作都走 mutate()（先深拷贝再改再写回），保证 React 状态、localStorage 和撤销快照三者一致。
 *
 * v0.2 新增三条主线：
 * ① 启动时可能要先迁移（失败 → MigrationFailPage，绝不写坏数据）；
 * ② 同步 = 解析 → 计划 → 用户确认 → apply（撤销按次快照，与状态变更共用一套 undo）；
 * ③ 面经 = 独立的三个数组，派生逻辑全在 lib/interview.ts 里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppApi,
  InsightsTab,
  NewApplicationInput,
  NewExperienceInput,
  NewInterviewInput,
  QuestionDraft,
  QuickNoteContext,
  QuickNoteInput,
  QuickNoteResult,
  StatusChangeOpts,
  SyncPlanOutcome,
  ViewKey,
} from './lib/api';
import { VIEWS } from './lib/api';
import type {
  AppSettings,
  Application,
  Company,
  DB,
  Interview,
  InterviewExperience,
  Mastery,
  NoteType,
  PlatformId,
  Question,
  ResumeContent,
  Status,
  TemplateId,
} from './types';
import type { NewCalendarEventInput, ParsedCourseInput } from './lib/api';
import {
  activeBackendName,
  checkQuota,
  emptyDB,
  exportJSON,
  importFromText,
  isPersistenceLocked,
  loadDB,
  loadUIView,
  lockPersistence,
  markExported,
  saveDB,
  saveUIView,
  unlockPersistence,
  type LoadResult,
} from './lib/storage';
import { buildSampleDB } from './lib/sample';
import {
  STATUS_LABEL,
  lastActivityAtOf,
  revertStatusChange,
  statusChangeText,
  type StatusUndo,
} from './lib/rules';
import { isDeleted, sweepTrash, trashReminder, trashedApps, trashedResumes, visibleDB } from './lib/trash';
import {
  activeVersionsOf,
  applyResumeSlice,
  createResume,
  duplicateResume,
  purgeResume,
  purgeVersion,
  referencingApplications,
  renameResume,
  renameVersion,
  restoreResume,
  restoreVersion,
  saveVersion,
  setPrimaryVersion,
  snapshotResumes,
  softDeleteResume,
  softDeleteVersion,
  switchTemplate,
  trashedVersionsOf,
  adoptVersionAsDraft,
  versionQuotaHint,
  type ResumeSlice,
  type SaveVersionResult,
} from './resume/versions';
import { bindResumeVersion as bindResumeVersionDraft } from './resume/bind';
import { cloneDB, companyFullName, companyLabel, downloadBlob, downloadText, pad2, safeHref, textBytes, uid } from './lib/util';
import {
  PORTABLE_FILES,
  buildZip,
  formatSums,
  portableReadme,
  portableZipName,
  type ZipEntry,
} from './lib/portable';
import { rebuildSelfHtml, sha256Hex } from './lib/selfSnapshot';
import { todayISO } from './lib/date';
import { budgetLevelOf, clampText, measureDB } from './lib/budget';
import {
  buildApplicationsCSV,
  buildInterviewsICS,
  csvFilename,
  icsFilename,
} from './lib/tableExport';
import {
  QUESTION_TEXT_LIMIT,
  applyQuestionEdit,
  buildQuestionRows,
  nextReviewAtFor,
  revertQuestionBatch,
  revertQuestionEdit,
  type QuestionBatchUndo,
  type QuestionEditUndo,
} from './lib/interview';
import { markdownFileName, renderManyMarkdown } from './lib/interviewMarkdown';
import { applySuggestions, rejectSuggestions, revertAi } from './ai/suggestions';
import { checkAiReady } from './ai/settings';
import { chatCompletions, GatewayError } from './ai/gateway';
import { buildRequestLogEntry, capRequestLog, fieldsFingerprint } from './ai/requestLog';
import { createSuggestions } from './ai/suggestions';
import { buildScenarioMessages, parseScenarioOutput, scenarioPluginId, toNewSuggestions } from './ai/scenarios';
import type { AiRunInput, AiRunOutcome, AiUndo, NewAISuggestion, PreviewField } from './ai/types';
import { PluginBroker, type SendAiInput } from './plugins/broker';
import { parseManifest } from './plugins/manifest';
import {
  PLUGIN_HTML_KEY,
  pluginIdForName,
  readRegistry,
  storageGet,
  storagePurgePlugin,
  storageSet,
  writeRegistry,
} from './plugins/storage';
import { RPC_VERSION, type PluginPermission, type PluginRegistration, type RpcEnvelope, type RpcErrorCode } from './plugins/types';
import { PluginFrame } from './components/plugins/PluginsPanel';
import { SendPreviewDialog } from './components/ai/SendPreviewDialog';
import { detectCapture, pickAdapter, toAdapterInput } from './lib/sync/capture';
import {
  bindHandle,
  describeReadOnly,
  peekPendingWrite,
  replayPending,
  requestWrite,
  resetBaseline,
  retryPermission,
  whenQueueIdle,
  type ReadOnlyReason,
  type WriteOutcome,
} from './lib/fileLink/engine';
import {
  type FileHandleLike,
  checkPermission,
  clearHandle,
  detectFileLinkCapability,
  loadHandle,
  saveHandle,
  type FileLinkCapability,
} from './lib/fileLink/handle';
import { encryptText, decryptText, isEncryptedEnvelope } from './lib/crypto';
import { buildDBFromCSV, previewCSV, type MappingPreview } from './lib/csvImport';
import { apply as applyMerge, plan as planMerge, revertSync } from './lib/sync/engine';
import type { MergePlan, PlannedRow, SyncUndo } from './lib/sync/types';
// 导入合并计划与同步合并计划是两个东西（一个是 DB 级、一个是字段级），故意分名
import { mergeImport, type MergePlan as ImportPlan } from './lib/merge';
import { TopBar, type SearchHit } from './components/TopBar';
import { TodoBar } from './components/TodoBar';
import { TodayView } from './components/TodayView';
import { BoardView } from './components/BoardView';
import { ListView } from './components/ListView';
import { CalendarView } from './components/CalendarView';
import { InsightsView } from './components/InsightsView';
import { DetailDrawer } from './components/DetailDrawer';
import { QuickAdd } from './components/QuickAdd';
import { SettingsDrawer } from './components/SettingsDrawer';
import { Toast, type ToastState } from './components/Toast';
import { Welcome } from './components/Welcome';
import { MigrationFailPage } from './components/MigrationFailPage';
import { BulkBanner } from './components/BulkBanner';
import { SyncDrawer, type SyncStep } from './components/sync/SyncDrawer';
import { ImportConfirm } from './components/ImportConfirm';
import { CsvImportDialog } from './components/CsvImportDialog';
import { QuickNote } from './components/interview/QuickNote';
import { ExperienceEditor } from './components/interview/ExperienceEditor';
import { ResumeView } from './components/resume/ResumeView';

/**
 * 键盘 1..N 与视图的对应关系。
 * ★ 必须与 `VIEWS`（lib/api.ts）**同序同长** —— TopBar 遍历 VIEWS 生成导航，
 * 这里少一条就是「导航上有、按 6 没反应」；多一条就是按了跳到不存在的视图。
 * 不在 lib/api 里放 VIEW_KEYS 是因为那个文件只该有类型与常量，不该知道「键盘」。
 */
const VIEW_KEYS: ViewKey[] = ['today', 'board', 'list', 'calendar', 'insights', 'resume'];

/** 一次可撤销的操作。v0.2 起不再只有状态变更，v0.4.1 起加入「删除投递」 */
type Undo =
  | { kind: 'status'; status: StatusUndo }
  /** v0.5：软删除后只需按 id 把标记清掉 —— 面试/备注本来就没被动过 */
  | { kind: 'delete'; appId: string }
  /** v0.5：导入合并。整库快照回滚是这里唯一允许的「整库级」撤销 ——
   *  因为导入本身就是一次全库级操作，按条撤销没有意义 */
  | { kind: 'import'; previous: DB }
  | { kind: 'sync'; sync: SyncUndo }
  /** v0.8：接受 AI 建议（目标写入 + 状态翻转一体回退，见 ai/suggestions.revertAi） */
  | { kind: 'ai'; ai: AiUndo }
  /** v0.9 / T-QB：题库行内编辑（只回退被改字段，不碰复习调度） */
  | { kind: 'question'; question: QuestionEditUndo }
  /** v0.9 / T-QB：快记一次落库（面经壳 + 一批题，⌘Z 整批回退） */
  | { kind: 'batch'; batch: QuestionBatchUndo }
  /**
   * v0.9 / T05：简历与版本的结构操作。
   * 只回滚三块（resumes / resumeVersions / defaultResumeVersionId）——
   * 删一个版本不该把「刚记的一场面试」一起撤掉。
   */
  | { kind: 'resume'; resume: ResumeSlice };

/** 撤销栈里的一格：撤销动作 + 给用户看的名字 +（可选）重做动作 */
interface UndoEntry {
  label: string;
  undo: Undo;
  /** 同步合并无法重放（当时确认过的合并计划已经消费掉了），留空即「不可重做」 */
  redo?: () => void;
}

/** 撤销栈深度：10 步足够覆盖「手滑连点」，全部是字段级快照，不占内存 */
const UNDO_LIMIT = 10;

/** 题干上限从 lib/interview.ts 引（题库行内编辑的截断提示要报同一个数字，不能两处各写一个） */

/** 导出失败的统一提示（JSON / 加密 / CSV / ICS / 便携包五个出口各拼一次，改文案只动这一处） */
const MSG_EXPORT_BLOCKED = '导出失败，浏览器可能禁止了下载';

interface UIBoot {
  view: ViewKey;
  insightsTab: InsightsTab;
}

function initialUI(): UIBoot {
  const saved = loadUIView();
  const view = saved && VIEW_KEYS.includes(saved.view as ViewKey) ? (saved.view as ViewKey) : 'today';
  const insightsTab: InsightsTab = saved?.insightsTab === 'interview' ? 'interview' : 'data';
  return { view, insightsTab };
}

export default function App() {
  const [boot, setBoot] = useState<LoadResult>(() => loadDB());
  // v0.5：启动即清一次过期回收站。放在 useState 初始化里（而不是 effect），
  // 是为了让「清理」发生在第一帧渲染之前 —— 否则用户会先看到一条已过期 30 天的
  // 幽灵记录闪一下再消失。返回值里带 removedApps 用于事后告知。
  const [swept] = useState(() => sweepTrash(boot.db, new Date()));
  const [db, setDb] = useState<DB>(swept.db);
  const dbRef = useRef<DB>(swept.db);
  const [loadError, setLoadError] = useState<string | null>(boot.error);
  const [emptyContinue, setEmptyContinue] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  /**
   * 导入冲突裁决（v0.5 / D4）。三个状态必须一起动：
   * - snapshot：导入前的整库 JSON，用户点「取消」或撤销时都靠它
   * - pending ：待裁决的计划（含原始备份 db，改主意重算时用）
   * - overwrite：用户勾了「用备份覆盖」的本地 id 集合（默认空 = 全保留本地）
   */
  const [importOpen, setImportOpen] = useState(false);
  const [importPending, setImportPending] = useState<{ incoming: DB; plan: ImportPlan } | null>(null);
  const [importOverwrite, setImportOverwrite] = useState<ReadonlySet<string>>(() => new Set<string>());

  const [ui] = useState<UIBoot>(initialUI);
  const [view, setViewState] = useState<ViewKey>(ui.view);
  const [insightsTab, setInsightsTabState] = useState<InsightsTab>(ui.insightsTab);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());
  /** ＋记一家 的初始状态（看板某列里点「＋」时带入该列状态） */
  const [quickAddStatus, setQuickAddStatus] = useState<Status>('applied');

  /* ------------------- v0.6 文件联动（D8） ------------------- */
  /**
   * 句柄放 ref：它是个不可序列化的宿主对象，进 state 只会让 React 深度比较
   * 一个结构化克隆对象，既慢又没有任何意义。UI 需要的「文件名 / 状态」
   * 单独用 state 表达。
   */
  const fileHandleRef = useRef<FileHandleLike | null>(null);
  const [fileCapability] = useState<FileLinkCapability>(() => detectFileLinkCapability());
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileReadOnly, setFileReadOnly] = useState<ReadOnlyReason | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [pendingWrite, setPendingWrite] = useState(() => peekPendingWrite());

  /**
   * 加密口令只活在内存里。
   * 存 sessionStorage 会在「关掉标签页即失效」上更宽松，但也会让 XSS
   * 多一个取口令的地方 —— 而这个功能的全部价值就是「口令不在任何存储里」。
   */
  const encryptPassRef = useRef<string | null>(null);

  /* ------------------- v0.6 P1：CSV 映射与加密导入 ------------------- */
  /** 待确认的 CSV 映射（null = 没有） */
  const [csvPending, setCsvPending] = useState<{ fileName: string; preview: MappingPreview } | null>(null);
  /** 待输口令的加密备份 */
  const [encryptedFile, setEncryptedFile] = useState<{ fileName: string; text: string } | null>(null);
  const [encryptError, setEncryptError] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [importPassword, setImportPassword] = useState('');
  /**
   * 「启动后第一版数据不入队」的标记。
   *
   * 打开页面时 db 就是文件里读出来的那一版，如果直接把 effect 跑一遍，
   * 就会把同一份内容写回文件 —— 内容没变（引擎会 skip），但如果是首次连接，
   * 会白白生成一次基准 hash 与一次读盘。用一次性标记把这次跳过。
   */
  const skipFirstFileSync = useRef(true);

  /* ---------------- 同步面板状态（全是 UI 状态，数据只在 commit 时落地） ---------------- */
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncStep, setSyncStep] = useState<SyncStep>(1);
  const [syncPlan, setSyncPlan] = useState<MergePlan | null>(null);
  const [syncAdapterId, setSyncAdapterId] = useState<PlatformId | null>(null);
  const [syncAdapterStale, setSyncAdapterStale] = useState(false);

  /* ---------------- 面经浮层 ---------------- */
  const [quickNoteCtx, setQuickNoteCtx] = useState<QuickNoteContext | null>(null);
  const [experienceEditorId, setExperienceEditorId] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<number | null>(null);
  const undoStackRef = useRef<UndoEntry[]>([]);
  const redoStackRef = useRef<UndoEntry[]>([]);
  /** 重做期间不要清空重做栈 —— 否则重做一步就把剩下的整叠扔了 */
  const replayingRef = useRef(false);
  const highlightTimer = useRef<number | null>(null);

  /* ------------------------------------------------------------ 基础能力 */

  const showToast = useCallback((text: string, undo?: (() => void) | null): void => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, undo: undo ?? null });
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 5000);
  }, []);

  const mutate = useCallback((recipe: (draft: DB) => void): void => {
    const current = dbRef.current;
    const next = cloneDB(current);
    recipe(next);
    dbRef.current = next;
    setDb(next);
  }, []);

  /** 入栈。新操作会让「重做」失效 —— 标准撤销语义：重做只对刚撤销的那条链有效 */
  const pushUndo = useCallback((entry: UndoEntry): void => {
    const stack = undoStackRef.current;
    stack.push(entry);
    if (stack.length > UNDO_LIMIT) stack.splice(0, stack.length - UNDO_LIMIT);
    if (!replayingRef.current) redoStackRef.current = [];
  }, []);

  /** 按影响面撤销（状态变更 / 删除 / 一次同步），绝不整库回滚 */
  const performUndo = useCallback(
    (entry: UndoEntry): void => {
      const undo = entry.undo;
      mutate((draft) => {
        if (undo.kind === 'status') revertStatusChange(draft, undo.status);
        else if (undo.kind === 'delete') {
          draft.applications = draft.applications.map((app) =>
            app.id === undo.appId ? { ...app, deletedAt: null } : app,
          );
        } else if (undo.kind === 'import') {
          // 整库恢复：导入这一次操作本来就是全库级的，按条撤销没有意义。
          // 先清空再赋值，保持 draft 的对象身份不变（mutate 依赖它被 recipe 改）
          Object.assign(draft, structuredClone(undo.previous));
        } else if (undo.kind === 'ai') revertAi(draft, undo.ai);
        else if (undo.kind === 'question') revertQuestionEdit(draft, undo.question);
        else if (undo.kind === 'batch') revertQuestionBatch(draft, undo.batch);
        else if (undo.kind === 'resume') applyResumeSlice(draft, undo.resume);
        else revertSync(draft, undo.sync);
      });
    },
    [mutate],
  );

  const undoLast = useCallback((): void => {
    const stack = undoStackRef.current;
    const entry = stack.pop();
    if (!entry) {
      showToast('没有可撤销的步骤了');
      return;
    }
    performUndo(entry);
    redoStackRef.current.push(entry);
    showToast(
      `已撤销：${entry.label}${stack.length > 0 ? `（再按一次可继续撤，还剩 ${stack.length} 步）` : ''}`,
    );
  }, [performUndo, showToast]);

  const redoLast = useCallback((): void => {
    const stack = redoStackRef.current;
    const entry = stack.pop();
    if (!entry) {
      showToast('没有可重做的步骤');
      return;
    }
    if (!entry.redo) {
      stack.push(entry);
      showToast('这一步不支持重做 —— 同步合并的计划已经用掉了，需要重新粘贴同步');
      return;
    }
    replayingRef.current = true;
    try {
      entry.redo();
    } finally {
      replayingRef.current = false;
    }
    showToast(`已重做：${entry.label}`);
  }, [showToast]);

  // 每分钟刷新一次「现在」，沉默天数会自然增长
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 每次数据变化都落盘（体积 block 时 saveDB 会拒绝并返回错误串）
  //
  // ★ QA D4：这个 effect 在「渲染失败页并 return」**之前**就已经注册了。
  // 所以判断不能写在渲染路径里（那是在赌 effect 与 return 的先后），
  // 必须在这里读闸门：闸门锁着就一个字节都不写。闸门本身在 storage.ts。
  useEffect(() => {
    if (isPersistenceLocked()) return;
    const error = saveDB(db);
    setSaveError(error);
  }, [db]);

  /**
   * v0.6 文件联动：数据一变就把最新一版塞进写入队列。
   *
   * 为什么放在这里、而不是在 mutate 里直接写：
   * mutate 有 40 多个调用点，任何一个都可能被连续调用（比如批量改状态），
   * 在 mutate 里写等于让「写文件」和「改状态」耦合。放在 effect 里，
   * 队列天然拿到的是「渲染后确定的那一版」。
   *
   * 只在真正启用且可写时才入队：
   * - `enabled=false`：用户没开，一个字节都不碰文件
   * - `readOnly`：权限丢了 / 冲突没解决 —— 这时候写进去就是覆盖别人的改动
   */
  useEffect(() => {
    if (!db.settings.fileLink.enabled) return;
    if (!fileHandleRef.current) return;
    if (db.settings.fileLink.readOnly) return;
    // 启动后的第一次渲染不入队：那一版就是文件里读出来的内容，写回去只会把 mtime 刷一遍
    if (skipFirstFileSync.current) {
      skipFirstFileSync.current = false;
      return;
    }
    requestWrite(JSON.stringify(JSON.parse(exportJSON(db)), null, 2), new Date().toISOString());
  }, [db]);

  // 启动提示（v0.5）：先说过期清理，再说即将到期 —— 两件事别抢一个 toast
  useEffect(() => {
    if (swept.removedApps > 0) {
      showToast(
        `回收站里有 ${swept.removedApps} 条投递已满 30 天，已自动永久删除（含 ${swept.removedInterviews} 场面试、${swept.removedNotes} 条记录）`,
      );
      return;
    }
    const reminder = trashReminder(swept.db, new Date());
    if (reminder.expiring > 0) {
      showToast(
        `回收站有 ${reminder.expiring} 条投递归将在 ${reminder.soonestDaysLeft ?? 1} 天内永久删除，可在设置里恢复`,
      );
    }
    // 只在启动时提示一次：[swept] 恒定，不会因为之后的数据变化重复弹
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 记住当前视图 + 复盘二级 tab
  useEffect(() => {
    saveUIView({ view, insightsTab });
  }, [view, insightsTab]);

  const setView = useCallback((next: ViewKey): void => {
    setViewState(next);
  }, []);

  const setInsightsTab = useCallback((tab: InsightsTab): void => {
    setInsightsTabState(tab);
    setViewState('insights');
  }, []);

  const openDetail = useCallback((id: string): void => {
    setSelectedId(id);
  }, []);

  const closeDetail = useCallback((): void => {
    setSelectedId(null);
  }, []);

  const focusApp = useCallback((id: string): void => {
    setViewState('board');
    setHighlightedId(id);
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightedId(null), 4000);
    setSelectedId(id);
  }, []);

  const openNew = useCallback((initialStatus?: Status): void => {
    // 兜底：某些 onClick 会把 MouseEvent 直接当参数传进来
    setQuickAddStatus(typeof initialStatus === 'string' ? initialStatus : 'applied');
    setQuickAddOpen(true);
  }, []);

  const openSettings = useCallback((): void => {
    setSettingsOpen(true);
  }, []);

  const openSync = useCallback((step: SyncStep = 1): void => {
    setSyncStep(step);
    setSyncOpen(true);
  }, []);

  const closeSync = useCallback((): void => {
    setSyncOpen(false);
  }, []);

  /* ------------------------------------------------------------ 投递写操作 */

  const addApplication = useCallback(
    (input: NewApplicationInput): string => {
      const id = uid('app');
      const nowIso = new Date().toISOString();
      // 数据模型层的默认值是 wishlist；「记一家」浮层会显式传 applied（真实用法：投完才记）
      const status: Status = input.status || 'wishlist';
      // T06：默认绑「主版本」（活版本才作数）。手填了别的版本名就尊重手填，走旧文本桶。
      const settingsNow = dbRef.current.settings;
      const defaultVersion = settingsNow.defaultResumeVersionId
        ? dbRef.current.resumeVersions.find(
            (version) => version.id === settingsNow.defaultResumeVersionId && !isDeleted(version),
          )
        : undefined;
      const boundVersion =
        defaultVersion && (!input.resumeVersion || input.resumeVersion === defaultVersion.label)
          ? defaultVersion
          : undefined;
      mutate((draft) => {
        const existed = draft.companies.find((c) => c.name === input.companyName);
        let companyId: string;
        if (existed) {
          companyId = existed.id;
        } else {
          companyId = uid('c');
          const company: Company = {
            id: companyId,
            name: input.companyName,
            city: input.city,
            createdAt: nowIso,
          };
          draft.companies.push(company);
        }
        const application: Application = {
          id,
          companyId,
          jobTitle: input.jobTitle,
          jobType: 'daily',
          city: input.city,
          channel: input.channel,
          appliedAt: input.appliedAt || (status === 'wishlist' ? undefined : todayISO()),
          status,
          statusChangedAt: nowIso,
          lastActivityAt: nowIso,
          jdUrl: input.jdUrl,
          // v0.9 / T06：新建时默认绑主版本（冻结版）。不做这一步，新投递只有文本快照，
          // 统计会把它们全部归进「未绑定（旧数据）」桶 —— 把 v0.9 的新数据当成旧数据。
          // 只在用户没手填别的版本名（或填的正是主版本名）时才绑，手填了别的就尊重手填。
          resumeVersion: boundVersion ? boundVersion.label : input.resumeVersion,
          resumeVersionId: boundVersion?.id,
          salaryText: input.salaryText,
          daysPerWeek: input.daysPerWeek,
          durationMonths: input.durationMonths,
          silenceOverride: null,
          rejectedAtRound: null,
          nextActionAt: null,
          priority: input.priority,
          tags: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        draft.applications.push(application);
        if (status !== 'wishlist') {
          draft.notes.push({
            id: uid('n'),
            applicationId: id,
            type: 'system',
            content: `新建记录，初始状态：${STATUS_LABEL[status]}`,
            auto: true,
            touchedAt: nowIso,
          });
        }
      });
      return id;
    },
    [mutate],
  );

  const updateApplication = useCallback(
    (id: string, patch: Partial<Application>): void => {
      const nowIso = new Date().toISOString();
      mutate((draft) => {
        const target = draft.applications.find((a) => a.id === id);
        if (!target) return;
        const previousStatus = target.status;
        Object.assign(target, patch);
        target.updatedAt = nowIso;
        // 万一是通过 patch 改的状态，同样要刷新沉默基准，保证红色标记能自动消失
        if (patch.status && patch.status !== previousStatus) {
          target.statusChangedAt = nowIso;
          target.lastActivityAt = nowIso;
          // 用户手改过 status —— 记下来，下次同步默认不覆盖（PRD §B.5 硬规则 1）
          target.userEditedAt = { ...(target.userEditedAt ?? {}), status: nowIso };
        }
      });
    },
    [mutate],
  );

  /**
   * v0.9 / T06：绑定 / 改绑 / 解绑。逻辑全在 `resume/bind.ts` 纯函数层 ——
   * 这里只负责把 draft 递进去。F9（不碰 lastActivityAt / notes / 时间线）由那一层保证，
   * 测试在 `resume/bind.test.ts` 里显式回归。
   */
  const bindResumeVersion = useCallback(
    (appId: string, versionId: string | null): boolean => {
      let ok = false;
      mutate((draft) => {
        ok = bindResumeVersionDraft(draft, appId, versionId, new Date().toISOString());
      });
      return ok;
    },
    [mutate],
  );

  const changeStatus = useCallback(
    (id: string, status: Status, opts?: StatusChangeOpts): void => {
      const current = dbRef.current.applications.find((a) => a.id === id);
      if (!current || current.status === status) return;
      const from = current.status;
      const at = opts?.at || new Date().toISOString();
      const systemNoteId = uid('n');
      // 撤销快照只记「这次变更影响了什么」，不复制整库
      const undo: StatusUndo = {
        appId: id,
        prevStatus: from,
        prevStatusChangedAt: current.statusChangedAt,
        prevLastActivityAt: current.lastActivityAt,
        prevRejectedAtRound: current.rejectedAtRound ?? null,
        createdNoteId: systemNoteId,
      };
      mutate((draft) => {
        const target = draft.applications.find((a) => a.id === id);
        if (!target) return;
        target.status = status;
        target.statusChangedAt = at;
        target.lastActivityAt = at;
        target.updatedAt = at;
        target.userEditedAt = { ...(target.userEditedAt ?? {}), status: at };
        if (status === 'rejected' && opts?.round) target.rejectedAtRound = opts.round;
        draft.notes.push({
          id: systemNoteId,
          applicationId: id,
          type: 'system',
          content: statusChangeText(from, status),
          auto: true,
          touchedAt: at,
        });
      });
      const snapshot: Undo = { kind: 'status', status: undo };
      pushUndo({
        label: `状态 ${STATUS_LABEL[from]} → ${STATUS_LABEL[status]}`,
        undo: snapshot,
        // 重做 = 再执行一次同样的状态变更（会生成新的系统记录，不覆盖撤销掉的那条）
        redo: () => changeStatus(id, status, opts),
      });
      showToast(`已更新 · ${STATUS_LABEL[from]} → ${STATUS_LABEL[status]}`, undoLast);
    },
    [mutate, pushUndo, showToast, undoLast],
  );

  const deleteApplication = useCallback(
    (id: string): void => {
      const current = dbRef.current;
      const app = current.applications.find((item) => item.id === id);
      if (!app) return;
      // ★ v0.5：删除改为**软删除**（进回收站 30 天），不再抹掉行。
      //   所以这里不需要再手工拍「这一条带走了哪些面试/备注」——
      //   它们原样留在库里，靠父投递的 deletedAt 推导可见性（见 lib/trash.ts）。
      const nowIso = new Date().toISOString();
      const interviewCount = current.interviews.filter((item) => item.applicationId === id).length;
      const noteCount = current.notes.filter((item) => item.applicationId === id).length;
      mutate((draft) => {
        draft.applications = draft.applications.map((a) =>
          a.id === id ? { ...a, deletedAt: nowIso } : a,
        );
      });
      pushUndo({
        label: `删除「${app.jobTitle}」（含 ${interviewCount} 场面试、${noteCount} 条记录，可在回收站找回）`,
        undo: { kind: 'delete', appId: id },
        redo: () => deleteApplication(id),
      });
    },
    [mutate, pushUndo],
  );

  /* ------------------------------ 回收站操作（v0.5） ------------------------------ */

  const restoreApplication = useCallback(
    (id: string): void => {
      const app = dbRef.current.applications.find((item) => item.id === id);
      if (!app) return;
      mutate((draft) => {
        draft.applications = draft.applications.map((item) =>
          item.id === id ? { ...item, deletedAt: null } : item,
        );
      });
      showToast(`已恢复「${app.jobTitle}」：面试与沟通记录都在`);
    },
    [mutate, showToast],
  );

  const purgeApplication = useCallback(
    (id: string): void => {
      const app = dbRef.current.applications.find((item) => item.id === id);
      if (!app) return;
      mutate((draft) => {
        draft.applications = draft.applications.filter((item) => item.id !== id);
        draft.interviews = draft.interviews.filter((item) => item.applicationId !== id);
        draft.notes = draft.notes.filter((item) => item.applicationId !== id);
        // 面经不删：那是你写过的经验，companyName/jobTitle 是冗余快照
        draft.experiences = draft.experiences.map((exp) =>
          exp.applicationId === id ? { ...exp, applicationId: null } : exp,
        );
      });
      showToast(`已永久删除「${app.jobTitle}」，无法撤销`);
    },
    [mutate, showToast],
  );

  const emptyTrash = useCallback((): void => {
    const count = dbRef.current.applications.filter((a) => a.deletedAt).length;
    if (count === 0) {
      showToast('回收站是空的');
      return;
    }
    mutate((draft) => {
      const doomed = new Set(
        draft.applications.filter((a) => a.deletedAt).map((a) => a.id),
      );
      draft.applications = draft.applications.filter((a) => !doomed.has(a.id));
      draft.interviews = draft.interviews.filter((i) => !doomed.has(i.applicationId));
      draft.notes = draft.notes.filter((n) => !doomed.has(n.applicationId));
      draft.experiences = draft.experiences.map((exp) =>
        exp.applicationId && doomed.has(exp.applicationId) ? { ...exp, applicationId: null } : exp,
      );
    });
    showToast(`已清空回收站：永久删除 ${count} 条投递`);
  }, [mutate, showToast]);

  const extendTrash = useCallback(
    (id: string): void => {
      mutate((draft) => {
        draft.applications = draft.applications.map((app) => {
          if (app.id !== id || !app.deletedAt) return app;
          const base = Date.parse(app.deletedAt);
          if (Number.isNaN(base)) return app;
          return { ...app, deletedAt: new Date(base + 7 * 86_400_000).toISOString() };
        });
      });
      showToast('已延长 7 天');
    },
    [mutate, showToast],
  );

  const addNote = useCallback(
    (applicationId: string, type: NoteType, content: string, at?: string): void => {
      const touchedAt = at || new Date().toISOString();
      mutate((draft) => {
        draft.notes.push({
          id: uid('n'),
          applicationId,
          type,
          content,
          auto: false,
          touchedAt,
        });
        const target = draft.applications.find((a) => a.id === applicationId);
        if (target) {
          target.lastActivityAt = touchedAt;
          target.updatedAt = touchedAt;
        }
      });
    },
    [mutate],
  );

  const deleteNote = useCallback(
    (noteId: string): void => {
      mutate((draft) => {
        const note = draft.notes.find((n) => n.id === noteId);
        draft.notes = draft.notes.filter((n) => n.id !== noteId);
        if (!note) return;
        const target = draft.applications.find((a) => a.id === note.applicationId);
        if (target) {
          target.lastActivityAt = lastActivityAtOf(target, draft.notes);
        }
      });
    },
    [mutate],
  );

  const addInterview = useCallback(
    (input: NewInterviewInput): void => {
      const nowIso = new Date().toISOString();
      mutate((draft) => {
        const interview: Interview = {
          id: uid('iv'),
          applicationId: input.applicationId,
          // v0.8：0 合法（笔试记录，kind='written'）；缺省/非法回落 1
          round: input.round !== undefined && input.round >= 0 ? input.round : 1,
          totalRounds: null,
          scheduledAt: input.scheduledAt,
          durationMin: input.durationMin,
          format: input.format,
          locationOrLink: input.locationOrLink,
          interviewer: input.interviewer,
          prepChecklist: [],
          // v0.8：面试类型 additive，缺省不写字段（保持 diff 干净，与校验器同口径）
          ...(input.kind ? { kind: input.kind } : {}),
          result: input.result || 'pending',
          notes: input.notes,
        };
        draft.interviews.push(interview);
        const target = draft.applications.find((a) => a.id === input.applicationId);
        if (target) {
          target.lastActivityAt = nowIso;
          target.updatedAt = nowIso;
        }
      });
    },
    [mutate],
  );

  const updateInterview = useCallback(
    (id: string, patch: Partial<Interview>): void => {
      mutate((draft) => {
        const target = draft.interviews.find((i) => i.id === id);
        if (!target) return;
        Object.assign(target, patch);
      });
    },
    [mutate],
  );

  const deleteInterview = useCallback(
    (id: string): void => {
      mutate((draft) => {
        draft.interviews = draft.interviews.filter((i) => i.id !== id);
      });
    },
    [mutate],
  );

  const updateCompany = useCallback(
    (id: string, patch: Partial<Company>): void => {
      mutate((draft) => {
        const target = draft.companies.find((c) => c.id === id);
        if (!target) return;
        Object.assign(target, patch);
      });
    },
    [mutate],
  );

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>): void => {
      mutate((draft) => {
        // schemaVersion 声明的是数据格式，不是用户可改项：保留现值（2），绝不回写 1
        draft.settings = { ...draft.settings, ...patch, schemaVersion: draft.settings.schemaVersion };
      });
    },
    [mutate],
  );

  /**
   * v0.9 简历草稿落库（T02 写入通道）。
   *
   * 三个刻意的边界，改这个函数前先读一遍：
   * 1. **不 pushUndo**：编辑期不入撤销栈（A-07）。`⌘Z` 是操作级撤销，不是文本撤销；
   *    每次防抖提交都进栈会把用户的撤销栈冲成几十层「改了一个字」。
   * 2. **深拷贝写入**：传进来的是 React 状态里的对象，直接塞进库里会让「组件下一次
   *    setState」和「库里的值」共享引用，两个真相迟早对不上。
   * 3. **找不到简历就什么都不写**（可能刚被删）：静默返回，不造一条半残的记录。
   */
  const updateResumeContent = useCallback(
    (id: string, content: ResumeContent): void => {
      mutate((draft) => {
        const target = draft.resumes.find((item) => item.id === id);
        if (!target) return;
        target.content = cloneDB(content);
        target.updatedAt = new Date().toISOString();
      });
    },
    [mutate],
  );

  /* ------------------------------------------------------------ 简历与版本（v0.9 / T05） */

  /** 正在编辑的简历 id（null = 列表态）。不记忆到 localStorage：刷新后回列表 */
  const [resumeOpenedId, setResumeOpenedId] = useState<string | null>(null);

  /** 列表态的简历（软删的在 `trashedResumes(db)` 里，两摞互斥） */
  const resumeList = useMemo(() => db.resumes.filter((item) => !isDeleted(item)), [db.resumes]);

  /**
   * 跑一次简历结构操作，并把它变成一个撤销点。
   *
   * 三条语义（改之前先读）：
   * 1. `before` 在 mutate 之前取、`after` 在之后取，两边都是快照 ——
   *    撤销与重做走同一个 `applyResumeSlice`，不可能只对一半；
   * 2. recipe 返回 false / null 表示「什么都没改」（目标没了、名字没变、模板没变），
   *    这种**不入栈**：否则按一次 ⌘Z 撤销一个不存在的操作，看起来像撤销坏了；
   * 3. `changed` 谓词给「有返回值但可能失败」的操作用（存版本满额时返回 `{ok:false}`）。
   */
  const runResumeOp = useCallback(
    <T,>(label: string, recipe: (draft: DB) => T, changed?: (result: T) => boolean): T => {
      const before = snapshotResumes(dbRef.current);
      let result!: T;
      mutate((draft) => {
        result = recipe(draft);
      });
      const isChanged = changed ? changed(result) : result !== false && result !== null;
      if (isChanged) {
        const after = snapshotResumes(dbRef.current);
        pushUndo({
          label,
          undo: { kind: 'resume', resume: before },
          redo: () => {
            mutate((draft) => applyResumeSlice(draft, after));
          },
        });
      }
      return result;
    },
    [mutate, pushUndo],
  );

  const resumeCreate = useCallback(
    (input: { name: string; templateId: TemplateId }): string =>
      runResumeOp('新建简历', (draft) =>
        createResume(draft, { name: input.name, templateId: input.templateId, at: new Date().toISOString() }),
      ).id,
    [runResumeOp],
  );

  const resumeDuplicate = useCallback(
    (id: string): string | null =>
      runResumeOp('复制简历', (draft) => duplicateResume(draft, id, new Date().toISOString()))?.id ?? null,
    [runResumeOp],
  );

  const resumeRename = useCallback(
    (id: string, name: string): void => {
      runResumeOp('重命名简历', (draft) => renameResume(draft, id, name, new Date().toISOString()));
    },
    [runResumeOp],
  );

  const resumeSetTemplate = useCallback(
    (id: string, templateId: TemplateId): void => {
      runResumeOp('切换模板', (draft) => switchTemplate(draft, id, templateId, new Date().toISOString()));
    },
    [runResumeOp],
  );

  const resumeSoftDelete = useCallback(
    (id: string): void => {
      runResumeOp('删除简历', (draft) => softDeleteResume(draft, id, new Date().toISOString()));
      // 删掉的正好是打开着的那份 → 编辑器要退回列表，否则会停在一个已不存在的简历上
      setResumeOpenedId((current) => (current === id ? null : current));
    },
    [runResumeOp],
  );

  const resumeRestore = useCallback(
    (id: string): void => {
      runResumeOp('恢复简历', (draft) => restoreResume(draft, id));
    },
    [runResumeOp],
  );

  const resumePurge = useCallback(
    (id: string): void => {
      runResumeOp('永久删除简历', (draft) => purgeResume(draft, id));
      setResumeOpenedId((current) => (current === id ? null : current));
    },
    [runResumeOp],
  );

  const resumeSaveVersion = useCallback(
    (resumeId: string, label: string): SaveVersionResult =>
      runResumeOp(
        '存为新版本',
        (draft) => saveVersion(draft, resumeId, label, new Date().toISOString()),
        (result) => result.ok,
      ),
    [runResumeOp],
  );

  const resumeRenameVersion = useCallback(
    (versionId: string, label: string): void => {
      runResumeOp('重命名版本', (draft) => renameVersion(draft, versionId, label));
    },
    [runResumeOp],
  );

  const resumeSetPrimary = useCallback(
    (versionId: string): void => {
      runResumeOp('设为主版本', (draft) => setPrimaryVersion(draft, versionId));
    },
    [runResumeOp],
  );

  const resumeDeleteVersion = useCallback(
    (versionId: string): void => {
      runResumeOp('删除版本', (draft) => softDeleteVersion(draft, versionId, new Date().toISOString()));
    },
    [runResumeOp],
  );

  const resumeRestoreVersion = useCallback(
    (versionId: string): void => {
      runResumeOp('恢复版本', (draft) => restoreVersion(draft, versionId));
    },
    [runResumeOp],
  );

  const resumePurgeVersion = useCallback(
    (versionId: string): void => {
      runResumeOp('永久删除版本', (draft) => purgeVersion(draft, versionId));
    },
    [runResumeOp],
  );

  const resumeAdoptAsDraft = useCallback(
    (versionId: string): void => {
      runResumeOp('以此版本为草稿', (draft) => adoptVersionAsDraft(draft, versionId, new Date().toISOString()));
    },
    [runResumeOp],
  );

  /* ------------------------------------------------------------ 同步 */

  const planSync = useCallback(
    (input: { text: string; platform?: PlatformId; capturedAt: string }): SyncPlanOutcome => {
      const nowIso = new Date().toISOString();
      const capturedAt = input.capturedAt || nowIso;
      const payload = detectCapture(input.text, capturedAt);
      if (payload.kind === 'empty') {
        return { ok: false, error: '粘贴区是空的 —— 先在平台列表页 Ctrl+A / Ctrl+C 全选复制' };
      }
      if (payload.kind === 'backup-json') {
        return { ok: false, error: '这是一份数据备份文件，不是平台页面。备份请去「设置 → 导入」里恢复' };
      }

      const picked = pickAdapter(payload, input.platform, nowIso);
      const parsed = picked.adapter.parse(toAdapterInput(payload), { now: nowIso });
      if (parsed.records.length === 0 && parsed.unparsed.length === 0) {
        return {
          ok: false,
          error: `${picked.adapter.name} 一条都没识别出来。请确认复制的是「沟通中 / 已投递 / 投递记录」这类列表页，而不是聊天详情页`,
        };
      }

      const current = dbRef.current;
      const plan = planMerge({
        records: parsed.records,
        db: current,
        platform: picked.adapter.platform,
        capturedAt: payload.capturedAt,
        overrides: current.settings.sync.statusMapOverrides,
        autoRefreshActivity: current.settings.sync.autoRefreshActivity,
        now: nowIso,
        // ★ QA D1：解析失败的条目带进计划 —— 第 ② 步显示、第 ④ 步进暂存区，一条都不许蒸发
        unparsed: parsed.unparsed,
      });

      setSyncPlan(plan);
      setSyncAdapterId(picked.adapter.platform);
      setSyncAdapterStale(picked.stale);
      return { ok: true, plan, adapterId: picked.adapter.platform, adapterStale: picked.stale };
    },
    [],
  );

  const commitSync = useCallback(
    (rows: PlannedRow[]): void => {
      const nowIso = new Date().toISOString();
      const platform = syncPlan?.platform ?? syncAdapterId ?? 'custom';
      const capturedAt = syncPlan?.capturedAt ?? nowIso;
      const result = applyMerge(dbRef.current, {
        rows,
        now: nowIso,
        capturedAt,
        platform,
        // 同一份 unparsed 必须一起落库，否则「不会丢」仍然是假话
        unparsed: syncPlan?.unparsed ?? [],
      });

      dbRef.current = result.db;
      setDb(result.db);
      const undo: Undo = { kind: 'sync', sync: result.undo };
      pushUndo({ label: `同步合并 ${result.written} 条`, undo });

      const parts = [`已写入 ${result.written} 条`];
      if (result.staged > 0) parts.push(`${result.staged} 条留暂存`);
      if (result.discarded > 0) parts.push(`暂存超上限，丢弃最旧 ${result.discarded} 条`);
      showToast(parts.join(' · '), undoLast);

      // 平台「邀请面试 / 已面完」只提示，不替用户造数据（PRD §B.6 红线）
      const hints = new Set<string>();
      for (const row of rows) {
        for (const warning of row.warnings) {
          if (warning.includes('去约时间') || warning.includes('补一场面试记录')) hints.add(warning);
        }
      }
      if (hints.size > 0) window.setTimeout(() => showToast([...hints].join('；')), 900);
    },
    [pushUndo, showToast, syncAdapterId, syncPlan, undoLast],
  );

  const resolveStaged = useCallback(
    (stagedId: string, status: Status | null): void => {
      const item = dbRef.current.staging.find((entry) => entry.id === stagedId);
      if (!item) return;
      // 「没解析出来」的行没有公司名 —— 直接建一条「未知公司」只是把垃圾挪了个地方，
      // 引导用户走「手动补录」而不是替用户编一个公司名（QA D1）。
      // 注意：经过一次写盘 + 校验往返后 companyName 会被补成「（未识别公司）」，
      // 所以这里还要看 reason，不能只看公司名空不空。
      if (status && (item.reason === 'unparsed' || !item.parsed.companyName)) {
        showToast('这条没解析出公司名，请用「手动补录一条」把它记下来，或直接忽略');
        return;
      }
      if (status) {
        addApplication({
          companyName: item.parsed.companyName,
          jobTitle: item.parsed.jobTitle || '（未填岗位）',
          status,
          city: item.parsed.city,
          salaryText: item.parsed.salaryText,
          jdUrl: item.parsed.jdUrl,
          channel: item.platform === 'custom' ? 'other' : item.platform,
        });
      }
      mutate((draft) => {
        draft.staging = draft.staging.filter((entry) => entry.id !== stagedId);
      });
      showToast(status ? `已归到「${STATUS_LABEL[status]}」` : '已忽略这条');
    },
    [addApplication, mutate, showToast],
  );

  const clearStaging = useCallback((): void => {
    const count = dbRef.current.staging.length;
    mutate((draft) => {
      draft.staging = [];
    });
    showToast(`已忽略 ${count} 条待归类记录（平台上的原记录还在，下次同步会再出现在预览里）`);
  }, [mutate, showToast]);

  const ackSyncRisk = useCallback((): void => {
    const nowIso = new Date().toISOString();
    mutate((draft) => {
      draft.settings.sync = { ...draft.settings.sync, riskAckAt: nowIso };
    });
  }, [mutate]);

  /* ------------------------------------------------------------ 面经 */

  const addExperience = useCallback(
    (input: NewExperienceInput): string => {
      const id = uid('exp');
      const nowIso = new Date().toISOString();
      mutate((draft) => {
        const experience: InterviewExperience = {
          id,
          applicationId: input.applicationId ?? null,
          companyName: input.companyName.trim() || '未知公司',
          jobTitle: input.jobTitle?.trim() || undefined,
          round: input.round ?? null,
          interviewDate: input.interviewDate,
          result: input.result,
          overallNote: input.overallNote ? clampText(input.overallNote, 3000).text : undefined,
          source: input.source ?? 'self',
          originFile: input.originFile,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        draft.experiences.push(experience);
      });
      return id;
    },
    [mutate],
  );

  const updateExperience = useCallback(
    (id: string, patch: Partial<InterviewExperience>): void => {
      const nowIso = new Date().toISOString();
      mutate((draft) => {
        const target = draft.experiences.find((item) => item.id === id);
        if (!target) return;
        Object.assign(target, patch);
        target.updatedAt = nowIso;
      });
    },
    [mutate],
  );

  const deleteExperience = useCallback(
    (id: string): void => {
      mutate((draft) => {
        draft.experiences = draft.experiences.filter((item) => item.id !== id);
        draft.questions = draft.questions.filter((question) => question.experienceId !== id);
      });
    },
    [mutate],
  );

  /**
   * 往已有面经里批量加题（AI 拆分、社区导入等复用这个入口）。
   * 默认值 / 去重 / 截断全在 `buildQuestionRows` 里 —— 与快记走同一份口径，
   * 否则「快记录的题」和「别处加的题」会在题库里长得不一样（PRD §20.9）。
   */
  const addQuestions = useCallback(
    (experienceId: string, items: QuestionDraft[]): number => {
      const experience = dbRef.current.experiences.find((item) => item.id === experienceId);
      if (!experience) return 0;
      const nowIso = new Date().toISOString();
      const taken = new Set(
        dbRef.current.questions
          .filter((question) => question.experienceId === experienceId)
          .map((question) => question.text.trim().toLowerCase()),
      );
      const rows = buildQuestionRows({ experience, items, now: nowIso, taken, makeId: uid });
      if (rows.length === 0) return 0;
      mutate((draft) => {
        draft.questions.push(...rows);
        const target = draft.experiences.find((item) => item.id === experienceId);
        if (target) target.updatedAt = nowIso;
      });
      return rows.length;
    },
    [mutate],
  );

  /**
   * 快记落库（PRD §20.2）：面经壳 + 全部待记题 = **一次 mutate + 一个撤销点**。
   *
   * 顺序上先算题再 mutate：一道题都没写进去（全是重复 / 超长 / 空题干）时
   * 直接返回失败，不留下「0 题的空面经」—— 那东西用户还得自己去删。
   */
  const addQuickNote = useCallback(
    (input: QuickNoteInput): QuickNoteResult => {
      const nowIso = new Date().toISOString();
      const experienceId = uid('exp');
      const experience: InterviewExperience = {
        id: experienceId,
        applicationId: input.experience.applicationId ?? null,
        companyName: input.experience.companyName.trim() || '未知公司',
        jobTitle: input.experience.jobTitle?.trim() || undefined,
        round: input.experience.round ?? null,
        interviewDate: input.experience.interviewDate,
        result: input.experience.result,
        overallNote: input.experience.overallNote
          ? clampText(input.experience.overallNote, 3000).text
          : undefined,
        source: input.experience.source ?? 'self',
        originFile: input.experience.originFile,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const rows = buildQuestionRows({ experience, items: input.items, now: nowIso, makeId: uid });
      if (rows.length === 0) {
        return { ok: false, reason: '这些题都没存进去（可能是重复或超长），改一下再试' };
      }
      const batch: QuestionBatchUndo = {
        questionIds: rows.map((question) => question.id),
        createdExperienceId: experienceId,
      };
      mutate((draft) => {
        draft.experiences.push(experience);
        draft.questions.push(...rows);
      });
      pushUndo({
        label: `记 ${rows.length} 题面经`,
        undo: { kind: 'batch', batch },
        // 重做 = 把同一批（同一批 id）放回去，不生成新 id —— 否则重做后的题目
        // 和重做前不是同一条，撤销栈会开始漂
        redo: () => {
          mutate((draft) => {
            if (!draft.experiences.some((item) => item.id === experience.id)) {
              draft.experiences.push(structuredClone(experience));
            }
            const known = new Set(draft.questions.map((question) => question.id));
            for (const row of rows) {
              if (!known.has(row.id)) draft.questions.push(structuredClone(row));
            }
          });
        },
      });
      return {
        ok: true,
        experienceId,
        written: rows.length,
        skipped: input.items.length - rows.length,
      };
    },
    [mutate, pushUndo],
  );

  /**
   * 静默改字段（ExperienceEditor 的「失焦即存」输入框走这里）。
   * 字段白名单在 `applyQuestionEdit` 里 —— 调度三字段（reviewCount / nextReviewAt /
   * lastReviewedAt）就算传进来也会被丢掉，编辑永远改不动复习计划（PRD §20.4）。
   */
  const updateQuestion = useCallback(
    (id: string, patch: Partial<Question>): void => {
      const nowIso = new Date().toISOString();
      mutate((draft) => applyQuestionEdit(draft, id, patch, nowIso));
    },
    [mutate],
  );

  const deleteQuestion = useCallback(
    (id: string): void => {
      mutate((draft) => {
        draft.questions = draft.questions.filter((item) => item.id !== id);
      });
    },
    [mutate],
  );

  /**
   * 表单式编辑：一次 mutate + 一条撤销栈。
   * 与 updateQuestion（输入框逐字写库、不进栈）分开，避免打字把撤销栈冲爆。
   *
   * ★ 撤销快照只存「被改的那几个字段的旧值」：整题快照会连 `updatedAt` /
   *   `nextReviewAt` 一起回滚，而复习调度不归编辑管。
   */
  const editQuestion = useCallback(
    (id: string, patch: Partial<Question>): void => {
      const current = dbRef.current.questions.find((item) => item.id === id);
      if (!current) return;
      const before: QuestionEditUndo['before'] = {
        text: current.text,
        category: current.category,
        mastery: current.mastery,
        myAnswer: current.myAnswer,
        nextTime: current.nextTime,
      };
      const nowIso = new Date().toISOString();
      mutate((draft) => applyQuestionEdit(draft, id, patch, nowIso));
      pushUndo({
        label: `修改题目「${current.text.slice(0, 12)}${current.text.length > 12 ? '…' : ''}」`,
        undo: { kind: 'question', question: { questionId: id, before } },
        redo: () => editQuestion(id, patch),
      });
      showToast('已保存 · 点「撤销」可改回', undoLast);
    },
    [mutate, pushUndo, showToast, undoLast],
  );

  const reviewQuestion = useCallback(
    (id: string, mastery: Mastery): void => {
      const today = todayISO(new Date());
      mutate((draft) => {
        const target = draft.questions.find((item) => item.id === id);
        if (!target) return;
        target.mastery = mastery;
        target.reviewCount += 1;
        target.lastReviewedAt = today;
        target.nextReviewAt = nextReviewAtFor(mastery, today);
        target.updatedAt = new Date().toISOString();
      });
    },
    [mutate],
  );

  const openQuickNote = useCallback((ctx?: QuickNoteContext): void => {
    setQuickNoteCtx(ctx ?? {});
  }, []);

  const closeQuickNote = useCallback((): void => {
    setQuickNoteCtx(null);
  }, []);

  const openExperience = useCallback((id: string): void => {
    setExperienceEditorId(id);
  }, []);

  const closeExperience = useCallback((): void => {
    setExperienceEditorId(null);
  }, []);

  /* ------------------------------------------------------------ AI（v0.8 / T03） */

  /**
   * 接受勾选的建议：**单次 mutate** 内写目标表 + 状态翻 accepted + 一个撤销点。
   * 撤销语义与状态变更同款（⌘Z 整体回退，用户在 DetailDrawer 手写的内容不受影响 ——
   * 这里回退的只是这次确认写入的 AI 建议）。
   */
  const acceptSuggestions = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0) return;
      let undo: AiUndo | null = null;
      let applied = 0;
      mutate((draft) => {
        const result = applySuggestions(draft, new Set(ids), {
          nowIso: new Date().toISOString(),
          // D14 新建题必须挂在某场面经下，而这个上下文只有当前编辑器知道
          resolveQuestionExperienceId: () => experienceEditorId,
        });
        undo = result.undo;
        applied = result.applied;
      });
      if (applied === 0 || !undo) {
        showToast('这些建议都已被处理过，没有可接受的内容');
        return;
      }
      pushUndo({ label: `接受 ${applied} 条 AI 建议`, undo: { kind: 'ai', ai: undo } });
      showToast(`已接受 ${applied} 条 AI 建议`, undoLast);
    },
    [experienceEditorId, mutate, pushUndo, showToast, undoLast],
  );

  /** 忽略建议：只翻状态、不写目标表，不进撤销栈（7 天后由启动 sweep 清理） */
  const rejectSuggestionsByIds = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0) return;
      let count = 0;
      mutate((draft) => {
        count = rejectSuggestions(draft, new Set(ids), new Date().toISOString());
      });
      showToast(count > 0 ? `已忽略 ${count} 条建议（7 天后自动清理）` : '这些建议都已被处理过');
    },
    [mutate, showToast],
  );

  const clearRequestLog = useCallback((): void => {
    mutate((draft) => {
      draft.requestLog = [];
    });
    showToast('请求日志已清空');
  }, [mutate, showToast]);

  /**
   * RequestLog 记账：只在真实发送/拒绝时写，且永不落原文（字段白名单在 buildRequestLogEntry）。
   * 内置场景与插件共用这一个写入口 —— 日志只有一处实现，才不会两套口径。
   */
  const logPluginRequest = useCallback(
    (pluginId: string, hash: string, status: 'ok' | 'error', errorCode?: string): void => {
      const ai = dbRef.current.settings.ai;
      mutate((draft) => {
        const entry = buildRequestLogEntry(
          {
            pluginId,
            baseUrl: ai?.baseURL ?? '',
            model: ai?.model ?? '',
            sentFieldsHash: hash,
            status,
            ...(errorCode ? { errorCode } : {}),
          },
          new Date().toISOString(),
        );
        draft.requestLog = capRequestLog([...draft.requestLog, entry]);
      });
    },
    [mutate],
  );

  /**
   * 跑一次内置场景（D14/D15/D17）。**只能在 D13 预览确认之后调用** ——
   * `checked` 就是用户勾中的字段，这里不读、也不补任何库内数据。
   * 顺序与插件 ai_request 完全一致：fingerprint → gateway → 窄校验 → 建议入库 → 一条日志。
   */
  const runAiScenario = useCallback(
    async (input: AiRunInput): Promise<AiRunOutcome> => {
      const ai = dbRef.current.settings.ai;
      const readiness = checkAiReady(ai);
      if (!ai || !readiness.ready) return { ok: false, error: readiness.reason ?? 'AI 服务未配置' };
      const pluginId = scenarioPluginId(input.scenario);
      const hash = await fieldsFingerprint(input.checked);
      try {
        const result = await chatCompletions(ai, {
          messages: buildScenarioMessages(input.scenario, input.checked),
          stream: true,
          ...(input.onDelta ? { onDelta: input.onDelta } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const parsed = parseScenarioOutput(input.scenario, result.text);
        logPluginRequest(pluginId, hash, parsed.ok ? 'ok' : 'error', parsed.ok ? undefined : 'parse');
        if (!parsed.ok) return { ok: false, error: parsed.error };
        const list = createSuggestions(
          toNewSuggestions(input.scenario, input.targetId, parsed.items),
          new Date().toISOString(),
        );
        mutate((draft) => {
          for (const suggestion of list) draft.aiSuggestions.push(suggestion);
        });
        showToast(`AI 给出 ${list.length} 条建议 —— 勾选后才会写入`);
        return { ok: true, created: list.length };
      } catch (error) {
        const code = error instanceof GatewayError ? error.code : 'ai_failed';
        logPluginRequest(pluginId, hash, 'error', code);
        return { ok: false, error: aiErrorText(error) };
      }
    },
    [logPluginRequest, mutate, showToast],
  );

  /* ------------------------------------------------------------ 插件宿主（v0.8 / T04） */

  const pluginWindowsRef = useRef<Map<string, Window>>(new Map());
  const [aiPreviewRequest, setAiPreviewRequest] = useState<null | {
    pluginId: string;
    scenario: string;
    fields: PreviewField[];
    resolve: (checked: Record<string, string> | null) => void;
  }>(null);

  const registerPluginWindow = useCallback((pluginId: string, win: Window | null): void => {
    if (win) pluginWindowsRef.current.set(pluginId, win);
    else pluginWindowsRef.current.delete(pluginId);
  }, []);

  const postToPlugin = useCallback((pluginId: string, envelope: RpcEnvelope): void => {
    pluginWindowsRef.current.get(pluginId)?.postMessage(envelope, '*');
  }, []);

  /** 真实 AI 发送（插件 ai_request 的数据面）：指纹 → gateway → 日志 → 流推送 */
  const sendAiForPlugin = useCallback(
    async (input: SendAiInput): Promise<{ text: string } | null> => {
      const ai = dbRef.current.settings.ai;
      if (!ai?.baseURL || !ai.model) throw new Error('AI 服务未配置');
      const hash = await fieldsFingerprint(input.checked);
      try {
        const result = await chatCompletions(ai, {
          messages: input.messages,
          stream: input.stream,
          onDelta: input.stream
            ? (delta) =>
                postToPlugin(input.pluginId, {
                  v: RPC_VERSION,
                  id: input.requestId,
                  pluginId: input.pluginId,
                  type: 'ai_chunk',
                  payload: { requestId: input.requestId, delta },
                })
            : undefined,
        });
        if (input.stream) {
          postToPlugin(input.pluginId, {
            v: RPC_VERSION,
            id: input.requestId,
            pluginId: input.pluginId,
            type: 'ai_done',
            payload: { requestId: input.requestId, ...(result.finishReason ? { finishReason: result.finishReason } : {}) },
          });
        }
        logPluginRequest(input.pluginId, hash, 'ok');
        return input.stream ? null : { text: result.text };
      } catch (error) {
        const code = error instanceof GatewayError ? error.code : 'ai_failed';
        logPluginRequest(input.pluginId, hash, 'error', code);
        if (input.stream) {
          // 流式失败走 result.ok=false（ARCH：ai_done 只表正常结束）
          postToPlugin(input.pluginId, {
            v: RPC_VERSION,
            id: input.requestId,
            pluginId: input.pluginId,
            type: 'result',
            payload: { ok: false, code: 'ai_failed', message: error instanceof Error ? error.message : String(error) },
          });
          return null;
        }
        throw error;
      }
    },
    [logPluginRequest, postToPlugin],
  );

  const reportPluginSuggestions = useCallback(
    (_pluginId: string, list: NewAISuggestion[]): void => {
      mutate((draft) => {
        for (const suggestion of createSuggestions(list, new Date().toISOString())) draft.aiSuggestions.push(suggestion);
      });
      showToast(`插件提交了 ${list.length} 条 AI 建议（待你确认）`);
    },
    [mutate, showToast],
  );

  const broker = useMemo(
    () =>
      new PluginBroker({
        listPlugins: () => readRegistry(dbRef.current),
        windowOf: (pluginId) => pluginWindowsRef.current.get(pluginId) ?? null,
        post: postToPlugin,
        storageGet: (pluginId, key) => storageGet(dbRef.current, pluginId, key),
        storageSet: (pluginId, key, value) => storageSet(dbRef.current, pluginId, key, value, new Date().toISOString()),
        storageDelete: (pluginId, key) => {
          mutate((draft) => {
            const prefix = `${pluginId}::`;
            draft.pluginStorage = draft.pluginStorage.filter((row) => !(row.id.startsWith(prefix) && row.key === key));
          });
        },
        storageKeys: (pluginId) => {
          const prefix = `${pluginId}::`;
          return dbRef.current.pluginStorage.filter((row) => row.id.startsWith(prefix)).map((row) => row.key);
        },
        aiReady: () => checkAiReady(dbRef.current.settings.ai).ready,
        aiConfig: () => {
          const ai = dbRef.current.settings.ai;
          return ai?.baseURL && ai.model ? { baseURL: ai.baseURL, model: ai.model, isLocal: ai.isLocal } : null;
        },
        openPreview: (input) =>
          new Promise<Record<string, string> | null>((resolve) => {
            setAiPreviewRequest({ ...input, resolve });
          }),
        sendAi: sendAiForPlugin,
        logRefusal: (pluginId: string, _scenario: string, errorCode: RpcErrorCode) =>
          logPluginRequest(pluginId, 'refused', 'error', errorCode),
        reportSuggestions: reportPluginSuggestions,
      }),
    [postToPlugin, sendAiForPlugin, reportPluginSuggestions, logPluginRequest, mutate],
  );

  // 插件 → 宿主 的唯一入口：window message（来源/信封校验都在 broker 内）
  useEffect(() => {
    const handler = (event: MessageEvent): void => broker.handleEvent(event);
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [broker]);

  const setPluginEnabled = useCallback(
    (pluginId: string, enabled: boolean): void => {
      mutate((draft) => {
        const next = readRegistry(draft).map((item) => (item.pluginId === pluginId ? { ...item, enabled } : item));
        writeRegistry(draft, next, new Date().toISOString());
      });
    },
    [mutate],
  );

  const grantPluginPermission = useCallback(
    (pluginId: string, permission: PluginPermission, granted: boolean): void => {
      mutate((draft) => {
        const next = readRegistry(draft).map((item) => {
          if (item.pluginId !== pluginId) return item;
          const grantedSet = new Set(item.granted);
          if (granted) grantedSet.add(permission);
          else grantedSet.delete(permission);
          return { ...item, granted: [...grantedSet] };
        });
        writeRegistry(draft, next, new Date().toISOString());
      });
    },
    [mutate],
  );

  const uninstallPlugin = useCallback(
    (pluginId: string): void => {
      mutate((draft) => {
        writeRegistry(
          draft,
          readRegistry(draft).filter((item) => item.pluginId !== pluginId),
          new Date().toISOString(),
        );
        storagePurgePlugin(draft, pluginId);
      });
      pluginWindowsRef.current.delete(pluginId);
      showToast('插件已卸载（其存储数据一并清除）');
    },
    [mutate, showToast],
  );

  const loadPluginPackage = useCallback(
    async (file: File): Promise<string | null> => {
      const html = await file.text();
      const parsed = parseManifest(html);
      if (!parsed.ok) return parsed.error;
      const manifest = parsed.manifest;
      const pluginId = pluginIdForName(manifest.name);
      let error: string | null = null;
      mutate((draft) => {
        const list = readRegistry(draft);
        const existing = list.find((item) => item.pluginId === pluginId);
        const registration: PluginRegistration = {
          pluginId,
          name: manifest.name,
          version: manifest.version,
          permissions: manifest.permissions,
          enabled: existing?.enabled ?? false,
          granted: existing?.granted ?? [],
        };
        const next = existing
          ? list.map((item) => (item.pluginId === pluginId ? registration : item))
          : [...list, registration];
        writeRegistry(draft, next, new Date().toISOString());
        // html 存进插件自己的命名空间（reload 后面板/宿主能重建 iframe）
        const storageError = storageSet(draft, pluginId, PLUGIN_HTML_KEY, html, new Date().toISOString());
        // storageError 有两种：包体超限（quota）与包体不合规（bad_envelope，如 key 非法/不可序列化）
        if (storageError) {
          error = storageError === 'storage_quota' ? '插件包过大（超过 256 KB 上限）' : '插件包格式不合规，无法保存';
        }
      });
      if (error) return error;
      showToast(`插件「${manifest.name}」已加载：默认不授任何权限，请逐项授权后启用`);
      return null;
    },
    [mutate, showToast],
  );

  const exportExperienceMarkdown = useCallback(
    (experiences: InterviewExperience[], opts: { desensitize: boolean }): void => {
      if (experiences.length === 0) {
        showToast('没有可导出的面经');
        return;
      }
      const map = new Map<string, Question[]>();
      for (const experience of experiences) {
        map.set(
          experience.id,
          dbRef.current.questions.filter((question) => question.experienceId === experience.id),
        );
      }
      const text = renderManyMarkdown(experiences, map, opts);
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download =
        experiences.length === 1
          ? markdownFileName(experiences[0])
          : `面经-${todayISO()}-${experiences.length}场.md`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast(`已导出 ${experiences.length} 场面经${opts.desensitize ? '（已脱敏）' : ''}`);
    },
    [showToast],
  );

  const importCommunityFile = useCallback(
    (file: File): void => {
      const reader = new FileReader();
      reader.onerror = () => showToast('读取文件失败，请确认文件没有损坏');
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : '';
        const parsed = parseCommunityPayload(text, file.name);
        if (!parsed.ok) {
          showToast(`导入失败：${parsed.error}`);
          return;
        }
        const existingExp = new Set(dbRef.current.experiences.map((item) => item.id));
        const existingQ = new Set(dbRef.current.questions.map((item) => item.id));
        let addedExp = 0;
        let addedQ = 0;
        const nowIso = new Date().toISOString();
        mutate((draft) => {
          for (const item of parsed.experiences) {
            const id = item.id && !existingExp.has(item.id) ? item.id : uid('exp');
            if (existingExp.has(id)) continue;
            existingExp.add(id);
            draft.experiences.push({
              id,
              applicationId: null,
              companyName: item.companyName,
              jobTitle: item.jobTitle,
              round: item.round ?? null,
              interviewDate: item.interviewDate,
              result: item.result ?? 'unknown',
              overallNote: item.overallNote ? clampText(item.overallNote, 3000).text : undefined,
              source: 'community',
              originFile: file.name,
              createdAt: nowIso,
              updatedAt: nowIso,
            });
            addedExp += 1;
            for (const question of item.questions ?? []) {
              const qid = question.id && !existingQ.has(question.id) ? question.id : uid('q');
              if (existingQ.has(qid)) continue;
              existingQ.add(qid);
              draft.questions.push({
                id: qid,
                experienceId: id,
                category: question.category ?? null,
                difficulty: question.difficulty ?? 2,
                text: clampText(question.text, QUESTION_TEXT_LIMIT).text,
                myAnswer: question.myAnswer,
                mastery: 0,
                tags: [],
                nextReviewAt: undefined,
                reviewCount: 0,
                createdAt: nowIso,
                updatedAt: nowIso,
              });
              addedQ += 1;
            }
          }
        });
        showToast(
          addedExp === 0
            ? '这份题库里的面经都已经导入过了（按 id 去重）'
            : `已导入 ${addedExp} 篇社区面经 · ${addedQ} 道题（只读，标「社区导入」）`,
        );
      };
      reader.readAsText(file, 'utf-8');
    },
    [mutate, showToast],
  );

  /* ------------------------------------------------------------ 数据管理 */

  const loadSampleData = useCallback((): void => {
    const sample = buildSampleDB(new Date());
    dbRef.current = sample;
    setDb(sample);
    setWelcomeDismissed(true);
    showToast('示例数据已加载：8 家公司，覆盖 7 种状态');
  }, [showToast]);

  const clearAllData = useCallback((): void => {
    // 「回到初始状态」：回到第一次打开的样子 —— 空库 + 出厂设置 + 欢迎页重现。
    // 课表/日程也在 settings/events 里，一并清掉；欢迎页重新弹出，用户自己选下一步。
    const base = emptyDB();
    dbRef.current = base;
    setDb(base);
    setSelectedId(null);
    setWelcomeDismissed(false);
    setViewState('today');
    showToast('已回到初始状态：全部数据与设置已清空');
  }, [showToast]);

  /* ------------------------------------------------------------ 日历日程（v0.4） */

  const addCalendarEvent = useCallback(
    (input: NewCalendarEventInput): void => {
      mutate((draft) => {
        draft.events.push({
          id: uid('ev'),
          title: input.title.trim() || '日程',
          kind: input.kind ?? (input.weekly ? 'course' : 'personal'),
          start: input.start,
          end: input.end,
          weekly: Boolean(input.weekly),
          weekday: input.weekly ? input.weekday : undefined,
          date: input.weekly ? undefined : input.date,
        });
      });
    },
    [mutate],
  );

  const deleteCalendarEvent = useCallback(
    (id: string): void => {
      mutate((draft) => {
        draft.events = draft.events.filter((event) => event.id !== id);
      });
    },
    [mutate],
  );

  const importCourseEvents = useCallback(
    (courses: ParsedCourseInput[]): number => {
      if (courses.length === 0) return 0;
      let count = 0;
      mutate((draft) => {
        // 替换语义：同一份课表重复导入不会翻倍；手动记的事不动
        draft.events = draft.events.filter((event) => !(event.kind === 'course' && event.weekly));
        for (const course of courses) {
          draft.events.push({
            id: uid('ev'),
            title: course.name,
            kind: 'course',
            start: course.start,
            end: course.end,
            weekly: true,
            weekday: course.weekday,
          });
          count += 1;
        }
      });
      return count;
    },
    [mutate],
  );

  /**
   * 便携包（v0.5 / D5）：index.html + data.json + 使用说明 + SHA256SUMS。
   *
   * 与「导出 JSON」的分工要跟用户说清：JSON 是**给本应用导回来**的备份，
   * 便携包是**给别人 / 给另一台机器直接打开**的一整套东西。两者都留着，
   * 因为「我只是想备份」的用户不该被迫下载一个 zip。
   */
  const exportPortable = useCallback(async (): Promise<void> => {
    try {
      const current = dbRef.current;
      const now = new Date();
      const { html, scriptCount } = rebuildSelfHtml();
      if (scriptCount === 0) {
        showToast('这个环境取不到应用本体，请改用「导出 JSON」');
        return;
      }

      const dataJson = exportJSON(current);
      const exportedAt = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(
        now.getHours(),
      )}:${pad2(now.getMinutes())}`;
      const readme = portableReadme(__APP_VERSION__, exportedAt, {
        applications: current.applications.length,
        companies: current.companies.length,
        interviews: current.interviews.length,
      });

      const files: ZipEntry[] = [
        { name: PORTABLE_FILES.app, data: textBytes(html) },
        { name: PORTABLE_FILES.data, data: textBytes(dataJson) },
        { name: PORTABLE_FILES.readme, data: textBytes(readme) },
      ];

      // 校验和：非安全上下文下 sha256Hex 返回空串，那就整份 SHASUMS 不带
      const sums = await Promise.all(
        files.map(async (file) => ({ name: file.name, sha256: await sha256Hex(file.data) })),
      );
      if (sums.every((row) => row.sha256 !== '')) {
        files.push({ name: PORTABLE_FILES.sums, data: textBytes(formatSums(sums)) });
      }

      const zip = buildZip(files);
      const ok = downloadBlob(
        // 显式切一份 ArrayBuffer：Uint8Array 的 buffer 类型可能是 SharedArrayBuffer，
        // 而 BlobPart 只接受 ArrayBuffer
        new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }),
        portableZipName(now),
      );
      if (ok) markExported();
      showToast(
        ok
          ? `已导出便携包（${current.applications.length} 条投递 + 应用本体）`
          : MSG_EXPORT_BLOCKED,
      );
    } catch {
      showToast(MSG_EXPORT_BLOCKED);
    }
  }, [showToast]);

  /* ------------------------- v0.6 文件联动动作 ------------------------- */

  /** 把写入结果翻译成用户能理解的一句话，并把冲突/权限丢失反映到设置里 */
  const absorbWriteOutcome = useCallback(
    (outcome: WriteOutcome | null): void => {
      if (!outcome) return;
      if (outcome.status === 'written') {
        mutate((draft) => {
          draft.settings.fileLink.lastSyncedAt = new Date().toISOString();
          draft.settings.fileLink.readOnly = false;
        });
        setFileReadOnly(null);
        return;
      }
      if (outcome.status === 'conflict') {
        // 冲突**不阻断**后续保存：文件已经安全地写着外部那一版，我们只是另存了一份
        mutate((draft) => {
          draft.settings.fileLink.lastConflictFile = outcome.conflictName;
        });
        showToast(`检测到文件被外部修改，已另存冲突副本 ${outcome.conflictName}（你的文件没有被覆盖）`);
        return;
      }
      if (outcome.status === 'need-permission') {
        mutate((draft) => {
          draft.settings.fileLink.readOnly = true;
        });
        setFileReadOnly('permission-lost');
        return;
      }
      if (outcome.status === 'failed') {
        showToast(outcome.error.slice(0, 80));
      }
    },
    [mutate, showToast],
  );

  /**
   * 连接文件（必须在 click 里调 —— 浏览器只认用户手势）。
   *
   * 流程刻意是「先选文件 → 再问权限」，而不是反过来：
   * 反过来的话，用户会在还没决定用哪个文件时就被要求授权，
   * 而且 showOpenFilePicker 的返回值本身就是权限请求的一部分。
   */
  const connectFile = useCallback(async (): Promise<void> => {
    const picker = (
      globalThis as unknown as {
        showSaveFilePicker?: (options?: unknown) => Promise<FileHandleLike & { createWritable?: unknown }>;
      }
    ).showSaveFilePicker;
    if (typeof picker !== 'function') {
      showToast('这个浏览器不支持文件联动');
      return;
    }
    setFileBusy(true);
    try {
      const handle = await picker({
        suggestedName: 'jobdesk-data.json',
        types: [{ description: '求职工作台数据', accept: { 'application/json': ['.json'] } }],
      });
      bindHandle(handle);
      await saveHandle(handle);
      resetBaseline();
      fileHandleRef.current = handle;
      setFileName(handle.name);
      setFileReadOnly(null);
      skipFirstFileSync.current = true;

      mutate((draft) => {
        draft.settings.fileLink.enabled = true;
        draft.settings.fileLink.readOnly = false;
        delete draft.settings.fileLink.lastConflictFile;
      });

      // 首次连接：把当前数据写进去（文件是空的 / 新建的，没有冲突风险）
      const text = JSON.stringify(JSON.parse(exportJSON(dbRef.current)), null, 2);
      requestWrite(text, new Date().toISOString());
      absorbWriteOutcome(await whenQueueIdle());
      showToast(`已连接 ${handle.name}，之后每次改动都会自动写入`);
    } catch (error) {
      // 用户点了取消不是错误，不出声
      const name = error instanceof Error ? error.name : '';
      if (name !== 'AbortError') showToast('连接文件失败，可以改用「导出 JSON」手动备份');
    } finally {
      setFileBusy(false);
    }
  }, [absorbWriteOutcome, mutate, showToast]);

  const disconnectFile = useCallback((): void => {
    bindHandle(null);
    fileHandleRef.current = null;
    void clearHandle();
    resetBaseline();
    setFileName(null);
    setFileReadOnly(null);
    mutate((draft) => {
      draft.settings.fileLink.enabled = false;
      draft.settings.fileLink.readOnly = false;
      delete draft.settings.fileLink.lastSyncedAt;
    });
    showToast('已断开文件联动。数据还在浏览器里，原来那个文件没有再被改动');
  }, [mutate, showToast]);

  /** 页面加载时把上次的句柄接回来。**不主动要权限** —— 那会被直接拒 */
  useEffect(() => {
    if (fileCapability !== 'full') return;
    let alive = true;
    void (async () => {
      const saved = await loadHandle();
      if (!alive || !saved) return;
      const handle = saved as FileHandleLike;
      const permission = await checkPermission(handle);
      fileHandleRef.current = handle;
      bindHandle(handle);
      setFileName(handle.name);
      if (permission !== 'granted') {
        setFileReadOnly('permission-lost');
        mutate((draft) => {
          draft.settings.fileLink.readOnly = true;
        });
      }
    })();
    return () => {
      alive = false;
    };
    // 只跑一次：能力不会在会话中途变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retryFilePermission = useCallback(async (): Promise<void> => {
    const handle = fileHandleRef.current;
    if (!handle) {
      showToast('还没有连接文件');
      return;
    }
    setFileBusy(true);
    try {
      const outcome = await retryPermission(handle);
      if (outcome !== 'granted') {
        showToast('浏览器没有授予写入权限。原始文件没有被改动，可以「另存为新文件」');
        return;
      }
      setFileReadOnly(null);
      mutate((draft) => {
        draft.settings.fileLink.readOnly = false;
      });
      // 权限回来之后才谈重放：这是规范里写的两个重放时机之一
      const replay = await replayPending(handle, new Date().toISOString());
      setPendingWrite(peekPendingWrite());
      if (replay.status === 'replayed') showToast('权限已恢复，上次中断的写入已补上');
      else if (replay.status === 'conflict') showToast(`文件被外部改过，已另存 ${replay.conflictName}`);
      else showToast('权限已恢复');
    } finally {
      setFileBusy(false);
    }
  }, [mutate, showToast]);

  const replayPendingWrite = useCallback(async (): Promise<void> => {
    const handle = fileHandleRef.current;
    if (!handle) return;
    setFileBusy(true);
    try {
      const outcome = await replayPending(handle, new Date().toISOString());
      setPendingWrite(peekPendingWrite());
      if (outcome.status === 'replayed') showToast('已补上中断的写入');
      else if (outcome.status === 'conflict') showToast(`文件被外部改过，已另存 ${outcome.conflictName}`);
      else if (outcome.status === 'failed') showToast(`重放失败：${outcome.error.slice(0, 60)}`);
      else if (outcome.status === 'dropped' || outcome.status === 'giveUp') showToast(outcome.reason);
      else showToast('没有待重放的写入');
    } finally {
      setFileBusy(false);
    }
  }, [showToast]);

  /** 只读三出口之一：下载当前库的原文（不碰联动文件） */
  const downloadReadOnlyRaw = useCallback((): void => {
    const text = exportJSON(dbRef.current);
    const ok = downloadText(text, 'application/json', `求职工作台-原始数据-${todayISO()}.json`);
    if (ok) markExported();
    showToast(ok ? '已下载当前数据' : '下载失败，浏览器可能禁止了下载');
  }, [showToast]);

  /** 只读三出口之三：另存为一个新文件，并把联动切到新文件上 */
  const saveAsNewFile = useCallback(async (): Promise<void> => {
    await connectFile();
  }, [connectFile]);

  /**
   * 开关加密（D10）。
   *
   * ★ 这里**只改意图**，不碰任何已写出的文件。
   *   「开启加密」不会立刻把之前的明文备份追认成加密的，
   *   「关闭加密」也不会去解密别人的文件 —— 它只是让下一次导出走另一条路。
   *   把「开关」和「文件内容」解耦，是避免「用户以为开了就安全了」的关键。
   */
  const toggleEncryption = useCallback(
    async (enabled: boolean, password: string): Promise<string | null> => {
      if (enabled) {
        // 立刻做一次真实加密试试：口令记错 / 环境不支持，现在就该失败
        const probe = await encryptText('{"probe":true}', password, new Date().toISOString());
        if (!probe.ok) return probe.error;
        encryptPassRef.current = password;
      } else {
        encryptPassRef.current = null;
      }
      mutate((draft) => {
        draft.settings.encryption = { enabled, changedAt: new Date().toISOString() };
      });
      showToast(
        enabled
          ? '已开启导出加密。下次「导出 JSON」会让你确认口令 —— 忘记口令这份备份无法恢复'
          : '已关闭导出加密，之后的导出是明文。之前导出的加密文件仍然需要口令才能打开',
      );
      return null;
    },
    [mutate, showToast],
  );

  const exportData = useCallback((): void => {
    const text = exportJSON(dbRef.current);
    // 文件名带 HHMM：同一天导多次不互相覆盖（与便携包 portableZipName 同一口径）。
    // 日期按本地时区，不用 toISOString()（UTC，本地 8 点前会早一天）
    const buildName = (encrypted: boolean): string => {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      return `求职工作台-备份-${todayISO()}-${hhmm}${encrypted ? '-encrypted' : ''}.json`;
    };

    const plainDownload = (): void => {
      try {
        const ok = downloadText(text, 'application/json', buildName(false));
        if (ok) markExported();
        showToast(ok ? '已导出 JSON 备份' : MSG_EXPORT_BLOCKED);
      } catch {
        showToast(MSG_EXPORT_BLOCKED);
      }
    };

    /**
     * 加密开关是开着的，但本次会话里没有口令（刷新过页面）——
     * 这时**必须问一句**，绝不能因为「拿不到口令」就悄悄导出明文。
     * 那种静默降级正是「我以为备份是加密的」这类事故的来源。
     */
    if (dbRef.current.settings.encryption.enabled) {
      const password = encryptPassRef.current;
      if (!password) {
        showToast('导出加密已开启，请到设置里输入口令后再导出');
        return;
      }
      void (async () => {
        const result = await encryptText(text, password, new Date().toISOString());
        if (!result.ok) {
          showToast(`加密失败，未导出明文：${result.error.slice(0, 60)}`);
          return;
        }
        const ok = downloadText(result.value, 'application/json', buildName(true));
        if (ok) markExported();
        showToast(ok ? '已导出加密备份（记得口令，忘记无法恢复）' : MSG_EXPORT_BLOCKED);
      })();
      return;
    }
    plainDownload();
  }, [showToast]);

  /**
   * CSV / ICS 是**单向**导出：只给别的软件看，导不回来。
   * 所以两个按钮都放在「导出 JSON」旁边而不替代它 —— 备份只有 JSON 算数，
   * 这一点在设置页的文案里也要说清，否则一定有人拿 CSV 当备份。
   */
  const exportCsv = useCallback((): void => {
    const current = dbRef.current;
    if (current.applications.length === 0) {
      showToast('还没有投递可以导出');
      return;
    }
    const ok = downloadText(
      buildApplicationsCSV(current, new Date()),
      'text/csv',
      csvFilename(new Date()),
    );
    showToast(ok ? `已导出 ${current.applications.length} 条投递（CSV）` : MSG_EXPORT_BLOCKED);
  }, [showToast]);

  const exportIcs = useCallback((): void => {
    const current = dbRef.current;
    if (current.interviews.length === 0) {
      showToast('还没有面试可以导出。先记一场面试吧');
      return;
    }
    const ok = downloadText(
      buildInterviewsICS(current, new Date()),
      'text/calendar',
      icsFilename(new Date()),
    );
    showToast(ok ? `已导出 ${current.interviews.length} 场面试（ICS）` : MSG_EXPORT_BLOCKED);
  }, [showToast]);

  /** 把合并计划落库，并把「撤销这一次导入」挂到撤销栈上 */
  const applyImportPlan = useCallback(
    (plan: ImportPlan): void => {
      const before = dbRef.current;
      dbRef.current = plan.db;
      setDb(plan.db);
      setSelectedId(null);
      setWelcomeDismissed(true);
      setImportOpen(false);
      setImportPending(null);

      const parts: string[] = [];
      if (plan.counts.added > 0) parts.push(`新增 ${plan.counts.added} 条`);
      if (plan.counts.addedInterviews > 0) parts.push(`${plan.counts.addedInterviews} 场面试`);
      if (plan.counts.addedNotes > 0) parts.push(`${plan.counts.addedNotes} 条记录`);
      if (plan.counts.unchanged > 0) parts.push(`${plan.counts.unchanged} 条已存在`);
      if (plan.counts.conflicts > 0) parts.push(`${plan.counts.conflicts} 处保留本地`);
      showToast(
        parts.length > 0 ? `导入完成：${parts.join('、')}` : '导入完成：没有需要新增的内容',
      );

      pushUndo({
        label: '导入备份',
        undo: { kind: 'import', previous: before },
        redo: () => applyImportPlan(plan),
      });
    },
    // 自引用（撤销后重做）没有别的写法，用 ref 拿最新闭包避免循环依赖
    [pushUndo, showToast],
  );

  /**
   * 导入（v0.5 / D4）：默认**增量合并**，不再整库覆盖。
   *
   * v0.4.1 是「导入 = 换成备份里的库」—— 拿一周前的备份补一条记录，
   * 这一周记的全没了。现在的流程：
   *   解析 → 合并计划（纯计算）→ 有冲突就交给 UI 逐条裁决 → 无冲突直接落库
   *
   * 冲突的默认值是**保留本地**（不勾 = 不动），这与同步面板的语义保持一致。
   */
  const importData = useCallback(
    (file: File): void => {
      const reader = new FileReader();
      reader.onerror = () => {
        setImportError('读取文件失败，请确认文件没有损坏。');
        showToast('读取文件失败');
      };
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : '';

        /*
         * v0.6 / P1：先判是不是加密备份。
         *
         * 这一步**必须在 JSON 解析之前**，因为加密备份的外层也是合法 JSON，
         * 但它的内容和本应用的数据结构完全对不上 —— 不先分流，
         * 用户会看到一句「缺少 settings / applications 字段」，
         * 完全猜不到「其实只是要输个口令」。
         */
        if (isEncryptedEnvelope(text)) {
          setEncryptedFile({ fileName: file.name, text });
          setEncryptError(null);
          return;
        }

        const result = importFromText(text);
        if (!result.ok) {
          // v0.6 / P1：JSON 走不通时，再试试它是不是一份 CSV / 手抄清单。
          // 顺序不能反：CSV 永远解析不出 settings 字段，先试 CSV 会让
          // 「备份文件少了个字」这种真损坏被误当成表格数据。
          if (/\.csv$/i.test(file.name) || text.includes(',')) {
            const preview = previewCSV(text, todayISO());
            if (preview.rows.length > 0) {
              setCsvPending({ fileName: file.name, preview });
              setImportError(null);
              return;
            }
          }
          setImportError(result.error);
          showToast(`导入失败：${result.error}`);
          return;
        }
        setImportError(null);

        const plan = mergeImport(dbRef.current, result.db);
        if (plan.conflicts.length > 0) {
          // 有冲突：先给用户看差异，确认后才落库。
          // 备份 db 一起存下来 —— 用户在面板里勾「用备份覆盖」时要按新选择重算，
          // 重算必须从**原始**备份出发，不能在已合并的结果上再合一次（会双重计入）
          setImportPending({ incoming: result.db, plan });
          setImportOverwrite(new Set<string>());
          setImportOpen(true);
          showToast(`识别到 ${plan.counts.conflicts} 处差异，请逐条确认`);
          return;
        }
        applyImportPlan(plan);
      };
      reader.readAsText(file, 'utf-8');
    },
    [applyImportPlan, showToast],
  );

  /**
   * 冲突面板的勾选（v0.5 / D4）。勾选集合是唯一状态，计划由它派生 ——
   * 每一次勾选都从**原始备份**重算，绝不在已有合并结果上再合一次。
   */
  const toggleImportOverwrite = useCallback((localId: string, next: boolean): void => {
    setImportOverwrite((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(localId);
      else copy.delete(localId);
      return copy;
    });
  }, []);

  const toggleAllImportOverwrite = useCallback(
    (next: boolean): void => {
      setImportOverwrite(() => {
        if (!next) return new Set<string>();
        return new Set((importPending?.plan.conflicts ?? []).map((row) => row.localId));
      });
    },
    [importPending],
  );

  /** 最终的确认导入：按当前勾选集合重算一次，然后落库 */
  const confirmImport = useCallback((): void => {
    if (!importPending) return;
    const plan = mergeImport(dbRef.current, importPending.incoming, {
      overwriteLocalIds: importOverwrite,
    });
    applyImportPlan(plan);
  }, [applyImportPlan, importOverwrite, importPending]);

  /** 取消导入：什么都没写进库，库和撤销栈都不动 */
  const cancelImport = useCallback((): void => {
    setImportPending(null);
    setImportOverwrite(new Set<string>());
    setImportOpen(false);
    showToast('已取消导入，数据没有变化');
  }, [showToast]);

  /**
   * 确认 CSV 导入（v0.6 / P1）。
   *
   * 与 JSON 导入共用撤销语义：整库快照进撤销栈。
   * 为什么不按条撤销：CSV 导入一次可能新增几十条 + 新建公司 + 写备注时间线，
   * 「撤销」在用户心里就是「把刚才那次导入退回去」，不是逐条点。
   */
  const confirmCsvImport = useCallback((): void => {
    if (!csvPending) return;
    const before = dbRef.current;
    const nowIso = new Date().toISOString();
    const result = buildDBFromCSV(before, csvPending.preview, nowIso);
    if (result.added === 0) {
      showToast(
        result.skippedExisting > 0
          ? `这 ${result.skippedExisting} 条都已经在库里了，没有新增`
          : '没有可导入的行',
      );
      setCsvPending(null);
      return;
    }
    dbRef.current = result.db;
    setDb(result.db);
    setCsvPending(null);
    setWelcomeDismissed(true);
    pushUndo({ label: '导入 CSV', undo: { kind: 'import', previous: before } });
    showToast(
      `已导入 ${result.added} 条投递${result.skippedExisting > 0 ? `，${result.skippedExisting} 条已存在跳过` : ''}`,
    );
  }, [csvPending, pushUndo, showToast]);

  /**
   * 解密一份加密备份并走正常的导入流程（v0.6 / D10）。
   *
   * ★ 解密失败时不保留口令、不重试自动降低强度、不提示「是不是少了几个字符」——
   *   GCM 认证失败的原因只有两种可能（口令错 / 文件被改），多说一个字都是误导。
   */
  const submitDecryptImport = useCallback(async (): Promise<void> => {
    if (!encryptedFile) return;
    if (!importPassword) {
      setEncryptError('请输入口令');
      return;
    }
    setDecrypting(true);
    try {
      const plain = await decryptText(encryptedFile.text, importPassword);
      if (!plain.ok) {
        setEncryptError(plain.error);
        return;
      }
      const result = importFromText(plain.value);
      if (!result.ok) {
        setEncryptError(`解开了，但内容不是本应用的备份：${result.error}`);
        return;
      }
      setEncryptedFile(null);
      setImportPassword('');
      setEncryptError(null);
      const plan = mergeImport(dbRef.current, result.db);
      if (plan.conflicts.length > 0) {
        setImportPending({ incoming: result.db, plan });
        setImportOverwrite(new Set<string>());
        setImportOpen(true);
        showToast(`识别到 ${plan.counts.conflicts} 处差异，请逐条确认`);
        return;
      }
      applyImportPlan(plan);
    } finally {
      setDecrypting(false);
    }
  }, [applyImportPlan, encryptedFile, importPassword, showToast]);

  /* ------------------------------------------------------------ 键盘快捷键 */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target ? target.tagName : '';
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target && target.isContentEditable);

      const withCmd = event.metaKey || event.ctrlKey;
      if (withCmd && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (withCmd && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoLast();
        else undoLast();
        return;
      }
      // Windows 习惯：Ctrl+Y 也是重做
      if (withCmd && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoLast();
        return;
      }
      if (typing) return;

      const overlayOpen =
        quickAddOpen || settingsOpen || selectedId !== null || syncOpen || quickNoteCtx !== null;

      if (event.key === 'Escape') {
        if (quickNoteCtx !== null) setQuickNoteCtx(null);
        else if (experienceEditorId) setExperienceEditorId(null);
        else if (syncOpen) setSyncOpen(false);
        else if (quickAddOpen) setQuickAddOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (selectedId) setSelectedId(null);
        return;
      }

      // v0.7：单键 J —— 详情抽屉打开时直接打开该投递的 JD 链接。
      // 必须放在 overlayOpen 判定**之前**：抽屉开着时 overlayOpen 恒为真。
      if (event.key === 'j' || event.key === 'J') {
        if (withCmd || event.altKey) return; // 不抢 ⌘J（浏览器下载）/ Alt+J
        if (!selectedId) return; // 抽屉没开就不做任何事
        const target = dbRef.current.applications.find((a) => a.id === selectedId);
        const href = safeHref(target?.jdUrl);
        if (!href || target?.jdLinkDeadAt) return;
        event.preventDefault();
        window.open(href, '_blank', 'noopener');
        return;
      }

      if (overlayOpen) return;

      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        openNew();
        return;
      }
      // 数字键按「序号」比，不按字符串比：`'10' <= '6'` 是 false，
      // 视图涨到两位数那天字符串比较会静默失灵（第 10 项永远按不出来）。
      const index = Number(event.key);
      if (Number.isInteger(index) && index >= 1 && index <= VIEW_KEYS.length) {
        const next = VIEW_KEYS[index - 1];
        if (next) setViewState(next);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [quickAddOpen, settingsOpen, selectedId, syncOpen, quickNoteCtx, experienceEditorId, undoLast, redoLast, openNew]);

  /* ------------------------------------------------------------ 搜索结果 */

  /**
   * v0.5：**全库唯一的回收站过滤点**。
   *
   * 所有视图、搜索、待办条、导出之外的派生计算都从这里取数据。
   * 为什么不要求每个组件自己判 `deletedAt`：40+ 个消费点，漏一个就是
   * 「删掉的投递还在看板上」—— 用户看到的是数据错乱，比崩溃更难查。
   * 放在这里还有一个好处：回收站页要看的「含已删除」版本可以用 `db` 本身，
   * 两边的边界一眼能看清。
   */
  const viewDB = useMemo(() => visibleDB(db), [db]);

  const hits = useMemo<SearchHit[]>(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    const list: SearchHit[] = [];
    for (const app of viewDB.applications) {
      const short = companyLabel(viewDB.companies, app.companyId);
      const full = companyFullName(viewDB.companies, app.companyId);
      const haystack = `${short} ${full} ${app.jobTitle}`.toLowerCase();
      if (haystack.includes(keyword)) {
        list.push({ id: app.id, company: short, jobTitle: app.jobTitle, status: app.status });
      }
    }
    return list;
  }, [query, viewDB.applications, viewDB.companies]);

  const pendingSyncCount = db.staging.length;
  const dbSize = useMemo(() => measureDB(db), [db]);
  const budgetLevel = budgetLevelOf(dbSize);
  /**
   * v0.6：只读状态的展示文案。
   *
   * 判定源有两个，缺一不可：
   * - 引擎层的 `fileReadOnly`（本次会话里发现的权限丢失 / 冲突）
   * - settings 里的 `fileLink.readOnly`（上次会话留下的锁，刷新后依然生效）
   * 只看其中一个，就会出现「刷新一下横幅就消失、其实还是写不进去」的假象。
   */
  const readOnlyState = useMemo(
    () => describeReadOnly(fileReadOnly ?? (db.settings.fileLink.readOnly ? 'permission-lost' : null)),
    [fileReadOnly, db.settings.fileLink.readOnly],
  );

  /** AI 就绪状态（baseURL+model 已配置）。false 时入口置灰 + 内联原因，不弹错误轰炸 */
  const aiReadiness = useMemo(() => checkAiReady(db.settings.ai), [db.settings.ai]);

  /** 插件注册表（pluginStorage 的 host 命名空间，reload 后原样恢复） */
  const pluginRegistry = useMemo<PluginRegistration[]>(() => readRegistry(db), [db]);

  const api: AppApi = {
    // ★ 视图拿到的是**已摘掉回收站**的库；回收站页与设置页直接读 `db`（含已删除）。
    db: viewDB,
    now,
    view,
    selectedId,
    highlightedId,
    setView,
    openDetail,
    closeDetail,
    focusApp,
    openNew,
    openSettings,
    toast: (text: string) => showToast(text),
    addApplication,
    updateApplication,
    bindResumeVersion,
    changeStatus,
    deleteApplication,
    restoreApplication,
    purgeApplication,
    emptyTrash,
    extendTrash,
    addNote,
    deleteNote,
    addInterview,
    updateInterview,
    deleteInterview,
    updateCompany,
    updateSettings,
    updateResumeContent,

    /**
     * v0.9 / T05：简历页。
     * 除了 `list` / `versionsOf` 这几个读函数，其余每个动作都在 `runResumeOp` 里包过 ——
     * 「一次操作 = 一个撤销点」在这里兑现，组件侧不需要知道撤销栈的存在。
     */
    resume: {
      list: resumeList,
      trashed: trashedResumes(db),
      openedId: resumeOpenedId,
      open: setResumeOpenedId,
      close: () => setResumeOpenedId(null),
      create: resumeCreate,
      duplicate: resumeDuplicate,
      rename: resumeRename,
      setTemplate: resumeSetTemplate,
      softDelete: resumeSoftDelete,
      restore: resumeRestore,
      purge: resumePurge,
      versionsOf: (resumeId: string) => activeVersionsOf(db, resumeId),
      trashedVersionsOf: (resumeId: string) => trashedVersionsOf(db, resumeId),
      quotaHint: (resumeId: string) => versionQuotaHint(db, resumeId),
      saveVersion: resumeSaveVersion,
      renameVersion: resumeRenameVersion,
      setPrimary: resumeSetPrimary,
      deleteVersion: resumeDeleteVersion,
      restoreVersion: resumeRestoreVersion,
      purgeVersion: resumePurgeVersion,
      adoptAsDraft: resumeAdoptAsDraft,
      referencesOf: (versionId: string) => referencingApplications(db, versionId).length,
      primaryVersionId: db.settings.defaultResumeVersionId ?? null,
    },

    loadSampleData,
    clearAllData,
    addCalendarEvent,
    deleteCalendarEvent,
    importCourseEvents,
    exportData,
    exportCsv,
    exportIcs,
    importData,
    exportPortable,
    checkStorage: checkQuota,
    storageBackend: activeBackendName,

    fileLink: {
      capability: fileCapability,
      fileName,
      readOnlyMessage: describeReadOnly(fileReadOnly).message,
      hasPending: pendingWrite !== null,
      busy: fileBusy,
      connect: connectFile,
      disconnect: disconnectFile,
      retryPermission: retryFilePermission,
      replayPending: replayPendingWrite,
      downloadRaw: downloadReadOnlyRaw,
      saveAs: saveAsNewFile,
      toggleEncryption,
    },

    insightsTab,
    setInsightsTab,

    syncOpen,
    openSync: () => openSync(1),
    closeSync,
    syncPlan,
    syncAdapterId,
    syncAdapterStale,
    planSync,
    commitSync,
    resolveStaged,
    clearStaging,
    ackSyncRisk,

    addExperience,
    updateExperience,
    deleteExperience,
    addQuestions,
    addQuickNote,
    updateQuestion,
    editQuestion,
    deleteQuestion,
    reviewQuestion,
    quickNote: quickNoteCtx,
    openQuickNote,
    closeQuickNote,
    exportExperienceMarkdown,
    importCommunityFile,

    experienceEditorId,
    openExperience,
    closeExperience,

    ai: {
      ready: aiReadiness.ready,
      readyReason: aiReadiness.reason,
      acceptSuggestions,
      rejectSuggestions: rejectSuggestionsByIds,
      clearRequestLog,
      runScenario: runAiScenario,
    },
    plugins: {
      list: () => pluginRegistry,
      setEnabled: setPluginEnabled,
      uninstall: uninstallPlugin,
      setPermission: grantPluginPermission,
      clearLogs: clearRequestLog,
      loadPackageFile: loadPluginPackage,
      registerWindow: registerPluginWindow,
    },
  };

  const showWelcome = db.applications.length === 0 && db.companies.length === 0 && !welcomeDismissed;

  /* ---------------- 迁移失败：只渲染失败页，绝不进主界面（也不写任何 key） ---------------- */

  if (boot.migration?.failed && !emptyContinue) {
    // ★ QA D4：进失败页的第一件事是**上锁**，锁必须在渲染期间就位 ——
    // 因为渲染完成后 effect 会立刻跑，那时再判断就晚了。
    // storage.saveDB 见到锁会直接返回，所以哪怕 effect 跑了也写不进去。
    lockPersistence();
    return (
      <MigrationFailPage
        reason={boot.migration.reason}
        raw={boot.migration.raw}
        backupKey={boot.migration.backupKey}
        failedAtKey={boot.migration.failedAtKey}
        onRetry={() => {
          const next = loadDB();
          // 重试成功 → 没有 migration.failed 了 → 解锁；仍然失败 → 保持锁定
          if (next.migration?.failed) lockPersistence();
          else unlockPersistence();
          setBoot(next);
          setDb(next.db);
          dbRef.current = next.db;
          setLoadError(next.error);
        }}
        onStartEmpty={() => {
          const blank = emptyDB();
          setEmptyContinue(true);
          // 用户明确选择「用空数据进入」：原文已在 jobdesk.v1.failedAt.<ISO> 留了一份，
          // 从这里开始正常写盘（否则用户记的东西一条也存不下）。
          unlockPersistence();
          setDb(blank);
          dbRef.current = blank;
        }}
      />
    );
  }

  // 没进失败页（正常启动 / 重试成功 / 用户选择空数据继续）：闸门必须是开的
  unlockPersistence();

  return (
    <div className="app">
      <TopBar
        view={view}
        onView={setView}
        query={query}
        onQuery={setQuery}
        hits={hits}
        onPick={(id) => {
          setQuery('');
          openDetail(id);
        }}
        onNew={() => openNew()}
        onSettings={openSettings}
        onSync={() => openSync(1)}
        pendingSync={pendingSyncCount}
        searchRef={searchRef}
      />

      <TodoBar api={api} />

      {loadError ? (
        <div className="banner banner--error">
          {loadError}
          <button type="button" className="link-btn" onClick={loadSampleData}>
            加载示例数据
          </button>
        </div>
      ) : null}
      {saveError ? <div className="banner banner--error">{saveError}</div> : null}
      {/*
        v0.6 / P1：文件联动状态横幅。
        只在「出了事」的时候出现（只读 / 有未完成的写入），
        正常连接不占一行 —— 状态本身在设置页里看，日常界面不该被一行
        「一切正常」占着，那只会训练用户忽略横幅。
      */}
      {readOnlyState.active ? (
        <div className="banner banner--warn">
          <strong>文件联动已切换为只读</strong>
          <span>{readOnlyState.message}</span>
          <div className="drawer__actions">
            <button type="button" className="btn btn--small" onClick={() => void api.fileLink.retryPermission()}>
              重试
            </button>
            <button type="button" className="btn btn--small" onClick={api.fileLink.downloadRaw}>
              下载原始文件
            </button>
            <button type="button" className="btn btn--small" onClick={() => void api.fileLink.saveAs()}>
              另存为新文件
            </button>
          </div>
        </div>
      ) : null}
      {pendingWrite ? (
        <div className="banner banner--warn">
          <strong>有一次写入没写完</strong>
          <span>上次保存时浏览器被关掉或进程被结束。这条内容还在，可以现在补写进文件。</span>
          <div className="drawer__actions">
            <button type="button" className="btn btn--small" onClick={() => void api.fileLink.replayPending()}>
              补写
            </button>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setPendingWrite(null)}>
              稍后
            </button>
          </div>
        </div>
      ) : null}
      <BulkBanner
        level={budgetLevel}
        size={dbSize}
        onExport={exportData}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="main">
        {view === 'today' ? <TodayView api={api} /> : null}
        {view === 'board' ? <BoardView api={api} /> : null}
        {view === 'list' ? <ListView api={api} /> : null}
        {view === 'calendar' ? <CalendarView api={api} /> : null}
        {view === 'insights' ? <InsightsView api={api} /> : null}
        {view === 'resume' ? <ResumeView api={api} /> : null}
      </main>

      <footer className="app-foot">
        <span>{VIEWS.length} 个视图</span>
        <span>N 新建 · 1-{VIEW_KEYS.length} 切视图 · ⌘K 搜索 · Esc 关闭</span>
        <span>数据只在本地</span>
      </footer>

      {selectedId ? <DetailDrawer api={api} /> : null}
      {quickAddOpen ? (
        <QuickAdd api={api} initialStatus={quickAddStatus} onClose={() => setQuickAddOpen(false)} />
      ) : null}
      {settingsOpen ? (
        <SettingsDrawer
          api={api}
          onClose={() => setSettingsOpen(false)}
          importError={importError}
          onDismissError={() => setImportError(null)}
          trashed={trashedApps(db)}
        />
      ) : null}
      {syncOpen ? <SyncDrawer api={api} onClose={closeSync} initialStep={syncStep} /> : null}
      {importOpen && importPending ? (
        <ImportConfirm
          counts={importPending.plan.counts}
          conflicts={importPending.plan.conflicts}
          overwrite={importOverwrite}
          onToggle={toggleImportOverwrite}
          onToggleAll={toggleAllImportOverwrite}
          onConfirm={confirmImport}
          onCancel={cancelImport}
        />
      ) : null}
      {quickNoteCtx !== null ? <QuickNote api={api} onClose={closeQuickNote} /> : null}
      {csvPending ? (
        <CsvImportDialog
          fileName={csvPending.fileName}
          preview={csvPending.preview}
          existingCount={dbRef.current.applications.length}
          onCancel={() => {
            setCsvPending(null);
            showToast('已取消导入，数据没有变化');
          }}
          onConfirm={confirmCsvImport}
        />
      ) : null}
      {encryptedFile ? (
        <div className="overlay" onClick={() => setEncryptedFile(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="输入备份口令"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal__head">
              <h2 className="modal__title">这份备份是加密的</h2>
              <button type="button" className="icon-btn" onClick={() => setEncryptedFile(null)} aria-label="关闭">
                ×
              </button>
            </header>
            <div className="modal__body">
              <p className="field__hint">
                <code>{encryptedFile.fileName}</code> 需要口令才能打开。
                口令不会被保存在任何地方 —— 如果忘了，这份文件无法恢复。
              </p>
              <label className="field">
                <span className="field__label">口令</span>
                <input
                  className="input"
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  value={importPassword}
                  onChange={(event) => {
                    setImportPassword(event.target.value);
                    setEncryptError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitDecryptImport();
                  }}
                />
              </label>
              {encryptError ? <p className="field__hint field__hint--danger">{encryptError}</p> : null}
            </div>
            <footer className="modal__foot">
              <button type="button" className="btn btn--ghost" onClick={() => setEncryptedFile(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void submitDecryptImport()}
                disabled={decrypting}
              >
                {decrypting ? '解密中…' : '解密并导入'}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
      {experienceEditorId ? (
        <ExperienceEditor api={api} experienceId={experienceEditorId} onClose={closeExperience} />
      ) : null}

      <Toast
        toast={toast}
        onClose={() => {
          if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
          setToast(null);
        }}
      />

      {/*
        v0.8：已启用插件的沙箱 iframe（宿主统一挂载，面板关闭后仍存活，
        broker 才能一直校验 message 来源）。隐藏容器 —— 插件 v0.8 只经 RPC 交互。
      */}
      {pluginRegistry
        .filter((plugin) => plugin.enabled)
        .map((plugin) => {
          const html = storageGet(db, plugin.pluginId, PLUGIN_HTML_KEY);
          if (typeof html !== 'string') return null;
          return (
            <div key={plugin.pluginId} style={{ display: 'none' }}>
              <PluginFrame
                pluginId={plugin.pluginId}
                html={html}
                name={plugin.name}
                registerWindow={registerPluginWindow}
              />
            </div>
          );
        })}

      {/* v0.8：插件 ai_request 触发的 D13 发送预览（强制弹层，取消 = 拒发） */}
      {aiPreviewRequest ? (
        <SendPreviewDialog
          title={`插件 AI 请求 · ${aiPreviewRequest.scenario}`}
          pluginId={aiPreviewRequest.pluginId}
          baseURL={db.settings.ai?.baseURL ?? ''}
          model={db.settings.ai?.model ?? ''}
          isLocal={db.settings.ai?.isLocal ?? false}
          fields={aiPreviewRequest.fields}
          onConfirm={(checked) => {
            aiPreviewRequest.resolve(checked);
            setAiPreviewRequest(null);
          }}
          onCancel={() => {
            aiPreviewRequest.resolve(null);
            setAiPreviewRequest(null);
          }}
        />
      ) : null}

      {showWelcome ? (
        <Welcome
          onLoadSample={loadSampleData}
          onStart={() => {
            setWelcomeDismissed(true);
            openNew();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * AI 失败的一句话人话（R-AI-5）：不弹错误框、不白屏，只在面板里内联一行。
 * 网络/超时单独给半句排查提示 —— 「连不上」和「模型胡说」是两种完全不同的挫败感。
 */
function aiErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GatewayError && (error.code === 'network' || error.code === 'timeout')) {
    return `连不上 AI 服务：${message}。检查本地模型是否在运行、地址是否以 /v1 结尾 —— 这次没有写入任何内容。`;
  }
  return `AI 请求失败：${message}。这次没有写入任何内容。`;
}

/* ================= 社区题库导入的格式校验（导出以便单测） ================= */
interface CommunityQuestion {
  id?: string;
  text: string;
  category?: Question['category'];
  difficulty?: 1 | 2 | 3;
  myAnswer?: string;
}

interface CommunityExperience {
  id?: string;
  companyName: string;
  jobTitle?: string;
  round?: number | null;
  interviewDate: string;
  result?: InterviewExperience['result'];
  overallNote?: string;
  questions?: CommunityQuestion[];
}

type CommunityParse = { ok: true; experiences: CommunityExperience[] } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 接受 `{experiences:[...]}` 与裸数组两种形态（community/SCHEMA.md 两种都写了） */
export function parseCommunityPayload(text: string, fileName: string): CommunityParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `${fileName} 不是合法的 JSON` };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.experiences)
      ? parsed.experiences
      : null;
  if (!list) return { ok: false, error: '文件里没有 experiences 数组（格式见 community/SCHEMA.md）' };

  const experiences: CommunityExperience[] = [];
  for (const [index, raw] of list.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `第 ${index + 1} 条不是对象` };
    const companyName = typeof raw.companyName === 'string' ? raw.companyName.trim() : '';
    const interviewDate = typeof raw.interviewDate === 'string' ? raw.interviewDate : '';
    if (!companyName) return { ok: false, error: `第 ${index + 1} 条缺少 companyName` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(interviewDate)) {
      return { ok: false, error: `第 ${index + 1} 条的 interviewDate 必须是 YYYY-MM-DD` };
    }
    const questions: CommunityQuestion[] = [];
    if (Array.isArray(raw.questions)) {
      for (const q of raw.questions) {
        if (!isRecord(q) || typeof q.text !== 'string' || !q.text.trim()) continue;
        questions.push({
          id: typeof q.id === 'string' ? q.id : undefined,
          text: q.text.trim(),
          category: typeof q.category === 'string' ? (q.category as Question['category']) : null,
          difficulty: q.difficulty === 1 || q.difficulty === 2 || q.difficulty === 3 ? q.difficulty : 2,
          myAnswer: typeof q.myAnswer === 'string' ? q.myAnswer : undefined,
        });
      }
    }
    experiences.push({
      id: typeof raw.id === 'string' ? raw.id : undefined,
      companyName,
      jobTitle: typeof raw.jobTitle === 'string' ? raw.jobTitle : undefined,
      round: typeof raw.round === 'number' ? raw.round : null,
      interviewDate,
      result:
        raw.result === 'passed' || raw.result === 'failed' || raw.result === 'pending' ? raw.result : 'unknown',
      overallNote: typeof raw.overallNote === 'string' ? raw.overallNote : undefined,
      questions,
    });
  }
  return { ok: true, experiences };
}
