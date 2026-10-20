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
import {
  emptyDB,
  exportJSON,
  importFromText,
  isPersistenceLocked,
  loadDB,
  loadUIView,
  lockPersistence,
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
import { cloneDB, companyFullName, companyLabel, downloadText, uid } from './lib/util';
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
import { QuickNote } from './components/interview/QuickNote';
import { ExperienceEditor } from './components/interview/ExperienceEditor';

const VIEW_KEYS: ViewKey[] = ['today', 'board', 'list', 'calendar', 'insights'];

/** 一次可撤销的操作。v0.2 起不再只有状态变更 */
type Undo = { kind: 'status'; status: StatusUndo } | { kind: 'sync'; sync: SyncUndo };

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
  const [db, setDb] = useState<DB>(boot.db);
  const dbRef = useRef<DB>(boot.db);
  const [loadError, setLoadError] = useState<string | null>(boot.error);
  const [emptyContinue, setEmptyContinue] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

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
  const lastUndoRef = useRef<Undo | null>(null);
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

  /** 按影响面撤销（状态变更 / 一次同步），绝不整库回滚 */
  const applyUndo = useCallback(
    (undo: Undo): void => {
      mutate((draft) => {
        if (undo.kind === 'status') revertStatusChange(draft, undo.status);
        else revertSync(draft, undo.sync);
      });
      lastUndoRef.current = null;
      showToast(
        undo.kind === 'status'
          ? '已撤销：状态和那条系统记录已复原，你写的记录都还在'
          : '已撤销这次同步：投递、note、暂存区都回到合并前',
      );
    },
    [mutate, showToast],
  );

  const undoLast = useCallback((): void => {
    const undo = lastUndoRef.current;
    if (!undo) {
      showToast('没有可撤销的上一步');
      return;
    }
    applyUndo(undo);
  }, [applyUndo, showToast]);

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
      lastUndoRef.current = snapshot;
      showToast(`已更新 · ${STATUS_LABEL[from]} → ${STATUS_LABEL[status]}`, () => applyUndo(snapshot));
    },
    [applyUndo, mutate, showToast],
  );

  const deleteApplication = useCallback(
    (id: string): void => {
      mutate((draft) => {
        draft.applications = draft.applications.filter((a) => a.id !== id);
        draft.interviews = draft.interviews.filter((i) => i.applicationId !== id);
        draft.notes = draft.notes.filter((n) => n.applicationId !== id);
        // 面经不跟着删：companyName/jobTitle 是冗余快照，删投递不该丢掉你写过的经验
        draft.experiences = draft.experiences.map((exp) =>
          exp.applicationId === id ? { ...exp, applicationId: null } : exp,
        );
      });
    },
    [mutate],
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
      lastUndoRef.current = undo;

      const parts = [`已写入 ${result.written} 条`];
      if (result.staged > 0) parts.push(`${result.staged} 条留暂存`);
      if (result.discarded > 0) parts.push(`暂存超上限，丢弃最旧 ${result.discarded} 条`);
      showToast(parts.join(' · '), () => applyUndo(undo));

      // 平台「邀请面试 / 已面完」只提示，不替用户造数据（PRD §B.6 红线）
      const hints = new Set<string>();
      for (const row of rows) {
        for (const warning of row.warnings) {
          if (warning.includes('去约时间') || warning.includes('补一场面试记录')) hints.add(warning);
        }
      }
      if (hints.size > 0) window.setTimeout(() => showToast([...hints].join('；')), 900);
    },
    [applyUndo, showToast, syncAdapterId, syncPlan],
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
    const base = emptyDB();
    const keepSettings = dbRef.current.settings;
    const cleared: DB = { ...base, settings: { ...keepSettings } };
    dbRef.current = cleared;
    setDb(cleared);
    setSelectedId(null);
    showToast('数据已清空（设置和课程表保留）');
  }, [showToast]);

  const exportData = useCallback((): void => {
    try {
      const text = exportJSON(dbRef.current);
      // 按本地日期命名，不用 toISOString()（UTC，本地 8 点前会早一天）
      const ok = downloadText(text, 'application/json', `求职工作台-备份-${todayISO()}.json`);
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
        dbRef.current = result.db;
        setDb(result.db);
        setSelectedId(null);
        setWelcomeDismissed(true);
        showToast(`导入成功：${result.db.applications.length} 条投递`);
      };
      reader.readAsText(file, 'utf-8');
    },
    [showToast],
  );

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
        undoLast();
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
  }, [quickAddOpen, settingsOpen, selectedId, syncOpen, quickNoteCtx, experienceEditorId, undoLast, openNew]);

  /* ------------------------------------------------------------ 搜索结果 */

  const hits = useMemo<SearchHit[]>(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    const list: SearchHit[] = [];
    for (const app of db.applications) {
      const short = companyLabel(db.companies, app.companyId);
      const full = companyFullName(db.companies, app.companyId);
      const haystack = `${short} ${full} ${app.jobTitle}`.toLowerCase();
      if (haystack.includes(keyword)) {
        list.push({ id: app.id, company: short, jobTitle: app.jobTitle, status: app.status });
      }
    }
    return list;
  }, [query, db.applications, db.companies]);

  const pendingSyncCount = db.staging.length;
  const dbSize = useMemo(() => measureDB(db), [db]);
  const budgetLevel = budgetLevelOf(dbSize);

  const api: AppApi = {
    db,
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
    addNote,
    deleteNote,
    addInterview,
    updateInterview,
    deleteInterview,
    updateCompany,
    updateSettings,
    loadSampleData,
    clearAllData,
    exportData,
    exportCsv,
    exportIcs,
    importData,

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
        />
      ) : null}
      {syncOpen ? <SyncDrawer api={api} onClose={closeSync} initialStep={syncStep} /> : null}
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
