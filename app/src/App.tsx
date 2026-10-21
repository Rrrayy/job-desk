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
  QuickNoteContext,
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
  Status,
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
import { sweepTrash, trashReminder, trashedApps, visibleDB } from './lib/trash';
import { cloneDB, companyFullName, companyLabel, downloadBlob, downloadText, pad2, textBytes, uid } from './lib/util';
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
import { deriveInitialNextReviewAt, nextReviewAtFor } from './lib/interview';
import { markdownFileName, renderManyMarkdown } from './lib/interviewMarkdown';
import { detectCapture, pickAdapter, toAdapterInput } from './lib/sync/capture';
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
import { QuickNote } from './components/interview/QuickNote';
import { ExperienceEditor } from './components/interview/ExperienceEditor';

const VIEW_KEYS: ViewKey[] = ['today', 'board', 'list', 'calendar', 'insights'];

/** 一次可撤销的操作。v0.2 起不再只有状态变更，v0.4.1 起加入「删除投递」 */
type Undo =
  | { kind: 'status'; status: StatusUndo }
  /** v0.5：软删除后只需按 id 把标记清掉 —— 面试/备注本来就没被动过 */
  | { kind: 'delete'; appId: string }
  /** v0.5：导入合并。整库快照回滚是这里唯一允许的「整库级」撤销 ——
   *  因为导入本身就是一次全库级操作，按条撤销没有意义 */
  | { kind: 'import'; previous: DB }
  | { kind: 'sync'; sync: SyncUndo };

/** 撤销栈里的一格：撤销动作 + 给用户看的名字 +（可选）重做动作 */
interface UndoEntry {
  label: string;
  undo: Undo;
  /** 同步合并无法重放（当时确认过的合并计划已经消费掉了），留空即「不可重做」 */
  redo?: () => void;
}

/** 撤销栈深度：10 步足够覆盖「手滑连点」，全部是字段级快照，不占内存 */
const UNDO_LIMIT = 10;

const QUESTION_TEXT_LIMIT = 2000;

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
        } else revertSync(draft, undo.sync);
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
      mutate((draft) => {
        let companyId = '';
        const existed = draft.companies.find((c) => c.name === input.companyName);
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
          resumeVersion: input.resumeVersion,
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
          round: input.round && input.round > 0 ? input.round : 1,
          totalRounds: null,
          scheduledAt: input.scheduledAt,
          durationMin: input.durationMin,
          format: input.format,
          locationOrLink: input.locationOrLink,
          interviewer: input.interviewer,
          prepChecklist: [],
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

  const addQuestions = useCallback(
    (experienceId: string, texts: string[]): number => {
      const experience = dbRef.current.experiences.find((item) => item.id === experienceId);
      if (!experience) return 0;
      const nowIso = new Date().toISOString();
      const existing = new Set(
        dbRef.current.questions
          .filter((question) => question.experienceId === experienceId)
          .map((question) => question.text.trim().toLowerCase()),
      );
      const incoming: Question[] = [];
      for (const raw of texts) {
        const text = clampText(raw.trim(), QUESTION_TEXT_LIMIT).text;
        if (!text) continue;
        if (existing.has(text.toLowerCase())) continue;
        existing.add(text.toLowerCase());
        incoming.push({
          id: uid('q'),
          experienceId,
          category: null,
          difficulty: 2,
          text,
          mastery: 0,
          tags: [],
          nextReviewAt: deriveInitialNextReviewAt(experience.interviewDate, nowIso),
          reviewCount: 0,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
      if (incoming.length === 0) return 0;
      mutate((draft) => {
        draft.questions.push(...incoming);
        const target = draft.experiences.find((item) => item.id === experienceId);
        if (target) target.updatedAt = nowIso;
      });
      return incoming.length;
    },
    [mutate],
  );

  const updateQuestion = useCallback(
    (id: string, patch: Partial<Question>): void => {
      const nowIso = new Date().toISOString();
      mutate((draft) => {
        const target = draft.questions.find((item) => item.id === id);
        if (!target) return;
        Object.assign(target, patch);
        if (patch.text) target.text = clampText(patch.text, QUESTION_TEXT_LIMIT).text;
        target.updatedAt = nowIso;
      });
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
          : '导出失败，浏览器可能禁止了下载',
      );
    } catch {
      showToast('导出失败，浏览器可能禁止了下载');
    }
  }, [markExported, showToast]);

  const exportData = useCallback((): void => {
    try {
      const text = exportJSON(dbRef.current);
      // 按本地日期命名，不用 toISOString()（UTC，本地 8 点前会早一天）
      const ok = downloadText(text, 'application/json', `求职工作台-备份-${todayISO()}.json`);
      if (ok) markExported();
      showToast(ok ? '已导出 JSON 备份' : '导出失败，浏览器可能禁止了下载');
    } catch {
      showToast('导出失败，浏览器可能禁止了下载');
    }
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
    showToast(ok ? `已导出 ${current.applications.length} 条投递（CSV）` : '导出失败，浏览器可能禁止了下载');
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
    showToast(ok ? `已导出 ${current.interviews.length} 场面试（ICS）` : '导出失败，浏览器可能禁止了下载');
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
        const result = importFromText(text);
        if (!result.ok) {
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
      if (overlayOpen) return;

      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        openNew();
        return;
      }
      if (event.key >= '1' && event.key <= '5') {
        const next = VIEW_KEYS[Number(event.key) - 1];
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
    updateQuestion,
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
      </main>

      <footer className="app-foot">
        <span>{VIEWS.length} 个视图</span>
        <span>N 新建 · 1-5 切视图 · ⌘K 搜索 · Esc 关闭</span>
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
