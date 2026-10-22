/**
 * 题库：按场折叠的概览卡 + 5 维筛选（公司 / 分类 / 掌握度 / 是否到期 / 关键词）+ 行内编辑。
 *
 * 复习模式（`开始复习` / `考前一分钟`）仍然只用 `lib/interview.ts` 的 `reviewQueue`
 * 排序（单测覆盖），组件里不另写一套 sort —— 否则「题库顺序」和「复习队列顺序」会慢慢分叉。
 * 列表模式按 PRD §20.3 的口径排：**场序 = 面试日期倒序，场内 = 录入顺序**。
 *
 * v0.9 / T-QB ②③：
 * - ② 一屏 20 张卡全是重复的公司/日期头 → 改成「每场一张概览卡」，默认全折叠，
 *   折叠态**不渲染任何题干 DOM**（只留一行卡头：公司 · 岗位 · 轮次 · 日期 + 「N 题 · 其中不会 M」）。
 *   筛选仍然先过题，筛完再按场分组（某场 0 命中 → 整卡不渲染）；上限 30 张卡，展开时该场全量渲染。
 * - ③ 每题可改：展开后行尾「编辑」进行内编辑态（同时只允许一行），
 *   保存走 `api.editQuestion`（一次 mutate + 一条撤销栈），取消一个字都不改。
 */

import { useMemo, useState } from 'react';
import type { Mastery, Question, QuestionCategory } from '../../types';
import type { AppApi } from '../../lib/api';
import {
  CATEGORY_LABEL,
  CATEGORY_NONE_LABEL,
  CATEGORY_OPTIONS,
  MASTERY_LABEL,
  QUESTION_TEXT_LIMIT,
  daysUntilReview,
  isDue,
  reviewQueue,
} from '../../lib/interview';
import { toDateISO } from '../../lib/date';
import { MasteryCategoryPicks } from './MasteryCategoryPicks';
import { ReviewCards } from './ReviewCards';

export interface QuestionBankProps {
  api: AppApi;
  onRecord: () => void;
}

type MasteryFilter = 'all' | Mastery;

/** 一屏最多这么多张概览卡（不是「60 题分页」—— 展开某场时该场命中题全量渲染） */
const CARD_LIMIT = 30;

/** 有未保存改动时拦一下的统一提示（切行 / 收起场次共用同一句） */
const MSG_UNSAVED = '这一题还有未保存的修改 —— 先保存或取消';

interface QuestionGroup {
  experienceId: string;
  companyName: string;
  jobTitle: string | null;
  round: number | null;
  interviewDate: string | null;
  questions: Question[];
  /** mastery === 0 的题数（概览卡上「其中不会 M」） */
  unknownCount: number;
}

export function QuestionBank({ api, onRecord }: QuestionBankProps) {
  const { db } = api;
  const [company, setCompany] = useState<string>('all');
  const [category, setCategory] = useState<'all' | QuestionCategory>('all');
  const [mastery, setMastery] = useState<MasteryFilter>('all');
  const [onlyDue, setOnlyDue] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'list' | 'review'>('list');
  const [reviewIds, setReviewIds] = useState<string[] | null>(null);
  /** 展开的场次（本地 state，不持久化 —— 下次进来还是清爽的概览） */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 正在编辑的题：同时只允许一行，避免「两行都没保存、切来切去不知道丢了哪个」 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 当前编辑行有没有改动（切换行 / 收起场次前用来拦一下，不静默丢弃） */
  const [editingDirty, setEditingDirty] = useState(false);

  const experienceById = useMemo(() => new Map(db.experiences.map((item) => [item.id, item])), [db.experiences]);
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const question of db.questions) {
      const experience = experienceById.get(question.experienceId);
      if (experience) set.add(experience.companyName);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [db.questions, experienceById]);

  const today = toDateISO(api.now);
  const nowIso = api.now.toISOString();

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return db.questions.filter((question) => {
      if (mastery !== 'all' && question.mastery !== mastery) return false;
      if (category !== 'all' && question.category !== category) return false;
      if (onlyDue && !isDue(question, today)) return false;
      if (company !== 'all') {
        const experience = experienceById.get(question.experienceId);
        if (!experience || experience.companyName !== company) return false;
      }
      if (needle) {
        const haystack = `${question.text} ${question.myAnswer ?? ''} ${question.nextTime ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [db.questions, mastery, category, onlyDue, today, company, experienceById, keyword]);

  /** 复习模式用的顺序（「不会的先看」），列表模式不用它 */
  const sorted = useMemo(() => reviewQueue(filtered, nowIso), [filtered, nowIso]);
  const dueCount = db.questions.filter((question) => isDue(question, today)).length;

  /**
   * 分组：对 `filtered` 单次 O(N) 扫描（不在场次里再 filter 一遍 —— 那是 O(N×场次)）。
   * `sorted` 保持录入顺序，所以组内顺序 = `questionsOf` 的录入顺序（PRD §20.3）；
   * 组之间按面试日期倒序，日期相同的保持录入先后（稳定排序）。
   */
  const groups = useMemo(() => {
    const byExperience = new Map<string, Question[]>();
    for (const question of filtered) {
      const bucket = byExperience.get(question.experienceId);
      if (bucket) bucket.push(question);
      else byExperience.set(question.experienceId, [question]);
    }
    const result: QuestionGroup[] = [];
    for (const [experienceId, questions] of byExperience) {
      const experience = experienceById.get(experienceId);
      result.push({
        experienceId,
        companyName: experience?.companyName ?? '未知公司',
        jobTitle: experience?.jobTitle ?? null,
        round: experience?.round ?? null,
        interviewDate: experience?.interviewDate ?? null,
        questions,
        unknownCount: questions.reduce((count, question) => (question.mastery === 0 ? count + 1 : count), 0),
      });
    }
    result.sort((a, b) => {
      if (a.interviewDate === b.interviewDate) return 0;
      if (a.interviewDate === null) return 1;
      if (b.interviewDate === null) return -1;
      return a.interviewDate < b.interviewDate ? 1 : -1;
    });
    return result;
  }, [filtered, experienceById]);

  if (mode === 'review') {
    const queue = reviewIds ? sorted.filter((question) => reviewIds.includes(question.id)) : sorted;
    return (
      <ReviewCards
        questions={queue}
        api={api}
        onExit={() => {
          setMode('list');
          setReviewIds(null);
        }}
      />
    );
  }

  if (db.questions.length === 0) {
    return (
      <div className="empty-block">
        <div className="empty-block__emoji">🗂</div>
        <div className="empty-block__title">题库还是空的</div>
        <p className="empty-block__text">面完一场点「＋ 记面经」，一行一题。记完这里会自动按「不会的先复习」排序。</p>
        <div className="empty-block__actions">
          <button type="button" className="btn btn--primary" onClick={onRecord}>
            ＋ 记面经
          </button>
        </div>
      </div>
    );
  }

  const visibleGroups = groups.slice(0, CARD_LIMIT);
  const hiddenGroups = groups.length - visibleGroups.length;

  const toggleGroup = (experienceId: string): void => {
    const open = Boolean(expanded[experienceId]);
    // 收起会把编辑框一起带走 —— 有未保存的改动就先拦一下
    if (open && editingDirty) {
      api.toast(MSG_UNSAVED);
      return;
    }
    setExpanded((prev) => ({ ...prev, [experienceId]: !prev[experienceId] }));
    // 收起时光标所在的编辑态跟着结束 —— 否则「保存」成了一个找不到行号的悬空按钮
    if (!open) return;
    const target = editingId ? db.questions.find((question) => question.id === editingId) : undefined;
    if (!target || target.experienceId === experienceId) {
      setEditingId(null);
      setEditingDirty(false);
    }
  };

  /** 点另一行的「编辑」：有未保存的改动就不许走（一行都不许丢） */
  const requestEdit = (id: string): void => {
    if (editingId === id) return;
    if (editingId && editingDirty) {
      api.toast(MSG_UNSAVED);
      return;
    }
    setEditingId(id);
    setEditingDirty(false);
  };

  return (
    <div className="qb">
      <div className="qb__toolbar">
        <label className="qb__filter">
          <span className="field__label">公司</span>
          <select className="select select--compact" value={company} onChange={(event) => setCompany(event.target.value)}>
            <option value="all">全部</option>
            {companies.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="qb__filter">
          <span className="field__label">分类</span>
          <select
            className="select select--compact"
            value={category}
            onChange={(event) => setCategory(event.target.value as 'all' | QuestionCategory)}
          >
            <option value="all">全部</option>
            {CATEGORY_OPTIONS.map((item) => (
              <option key={item} value={item}>
                {CATEGORY_LABEL[item]}
              </option>
            ))}
          </select>
        </label>

        <label className="qb__filter">
          <span className="field__label">掌握度</span>
          <select
            className="select select--compact"
            value={String(mastery)}
            onChange={(event) => {
              const value = event.target.value;
              setMastery(value === 'all' ? 'all' : (Number(value) as Mastery));
            }}
          >
            <option value="all">全部</option>
            <option value="0">{MASTERY_LABEL[0]}</option>
            <option value="1">{MASTERY_LABEL[1]}</option>
            <option value="2">{MASTERY_LABEL[2]}</option>
          </select>
        </label>

        <label className="qb__filter qb__filter--check">
          <input type="checkbox" checked={onlyDue} onChange={(event) => setOnlyDue(event.target.checked)} />
          <span>只看到期（{dueCount}）</span>
        </label>

        <label className="qb__filter qb__filter--search">
          <span className="field__label">搜索</span>
          <input
            className="input input--compact"
            value={keyword}
            placeholder="题干 / 我的回答"
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>

        <div className="qb__toolbar-actions">
          <button
            type="button"
            className="btn btn--small btn--primary"
            onClick={() => {
              // 考前一分钟：只看到期的，最多 10 张
              setReviewIds(sorted.filter((question) => isDue(question, today)).slice(0, 10).map((q) => q.id));
              setMode('review');
            }}
            disabled={dueCount === 0}
          >
            考前一分钟（{Math.min(dueCount, 10)}）
          </button>
          <button type="button" className="btn btn--small" onClick={() => { setReviewIds(null); setMode('review'); }}>
            开始复习
          </button>
          <button type="button" className="btn btn--small" onClick={onRecord}>
            ＋ 记面经
          </button>
        </div>
      </div>

      <p className="qb__summary">
        共 {db.questions.length} 题 · 当前筛选 {filtered.length} 题 · 命中 {groups.length} 场 · 到期 {dueCount} 题
      </p>

      {groups.length === 0 ? (
        <div className="empty-block">
          <div className="empty-block__emoji">🔍</div>
          <div className="empty-block__title">这个筛选下没有题</div>
          <p className="empty-block__text">把「只看到期」关掉，或者换一家公司看看。</p>
        </div>
      ) : (
        <>
          <ul className="qb__list">
            {visibleGroups.map((group) => {
              const open = Boolean(expanded[group.experienceId]);
              return (
                <li key={group.experienceId} className={`qb__group ${open ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    className="qb__group-head"
                    aria-expanded={open}
                    onClick={() => toggleGroup(group.experienceId)}
                  >
                    <span className="qb__group-caret" aria-hidden="true">
                      {open ? '▾' : '▸'}
                    </span>
                    <span className="qb__group-title">
                      {group.companyName}
                      {group.jobTitle ? ` · ${group.jobTitle}` : ''}
                      {group.round ? ` · 第 ${group.round} 轮` : ''}
                      {group.interviewDate ? ` · ${group.interviewDate}` : ''}
                    </span>
                    <span className="qb__group-count">
                      {group.questions.length} 题 · 其中不会 {group.unknownCount}
                    </span>
                  </button>

                  {/* 折叠态刻意什么都不渲染：题干 DOM 一进来，「一屏看清打了哪几场」就没了 */}
                  {open ? (
                    <ul className="qb__rows">
                      {group.questions.map((question) =>
                        question.id === editingId ? (
                          <QuestionEditor
                            key={question.id}
                            question={question}
                            onDirty={() => setEditingDirty(true)}
                            onSave={(patch) => {
                              api.editQuestion(question.id, patch);
                              setEditingId(null);
                              setEditingDirty(false);
                            }}
                            onCancel={() => {
                              setEditingId(null);
                              setEditingDirty(false);
                            }}
                          />
                        ) : (
                          <QuestionRow
                            key={question.id}
                            question={question}
                            today={today}
                            nowIso={nowIso}
                            onEdit={() => requestEdit(question.id)}
                          />
                        ),
                      )}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {hiddenGroups > 0 ? (
            <p className="muted qb__more">还有 {hiddenGroups} 场没显示 —— 用上面的筛选缩小范围。</p>
          ) : null}
        </>
      )}

      <p className="qb__summary">点场次展开题目，展开后每行右侧可以「编辑」。</p>
    </div>
  );
}

/** 展开后的一行：题干截断 + 分类/掌握度徽章 + 复习次数 + 编辑入口 */
function QuestionRow(props: {
  question: Question;
  today: string;
  nowIso: string;
  onEdit: () => void;
}) {
  const { question, today, nowIso, onEdit } = props;
  const due = isDue(question, today);
  const days = daysUntilReview(question, nowIso);

  return (
    <li className={`qb__row ${due ? 'qb__row--due' : ''}`}>
      <span className="qb__row-text" title={question.text}>
        {question.text}
      </span>
      <span className="chip">{question.category ? CATEGORY_LABEL[question.category] : CATEGORY_NONE_LABEL}</span>
      <span className={`qb__mastery qb__mastery--${question.mastery}`}>{MASTERY_LABEL[question.mastery]}</span>
      {due ? <span className="qb__due-flag">今天该复习</span> : null}
      <span className="muted qb__row-meta">
        复习 {question.reviewCount} 次
        {days === null
          ? ' · 未排复习'
          : days < 0
            ? ` · 逾期 ${Math.abs(days)} 天`
            : days === 0
              ? ' · 今天到期'
              : ` · ${days} 天后复习`}
      </span>
      {question.myAnswer ? <span className="qb__has-answer">已有我的回答</span> : null}
      <button type="button" className="link-btn qb__row-edit" onClick={onEdit}>
        编辑
      </button>
    </li>
  );
}

/**
 * 行内编辑态：题干 / 掌握度 / 分类 / 我的回答（可空）。
 *
 * 保存 = 四字段一个 patch（App 侧一次 mutate + 一条撤销栈）；
 * 取消 = 一个字都不提交。有改动时「取消」先提示一句再确认（不静默丢弃）。
 * 题干按 `QUESTION_TEXT_LIMIT` 截断，超限时**先说清楚**，不静默截。
 */
function QuestionEditor(props: {
  question: Question;
  onDirty: () => void;
  onSave: (patch: Partial<Question>) => void;
  onCancel: () => void;
}) {
  const { question, onDirty, onSave, onCancel } = props;
  const [text, setText] = useState(question.text);
  const [mastery, setMastery] = useState<Mastery>(question.mastery);
  const [category, setCategory] = useState<QuestionCategory | null>(question.category);
  const [answer, setAnswer] = useState(question.myAnswer ?? '');
  const [warned, setWarned] = useState(false);

  const dirty =
    text !== question.text ||
    mastery !== question.mastery ||
    category !== question.category ||
    answer !== (question.myAnswer ?? '');
  const tooLong = text.trim().length > QUESTION_TEXT_LIMIT;

  const save = (): void => {
    const next = text.trim();
    if (!next) return;
    onSave({ text: next, mastery, category, myAnswer: answer.trim() });
  };

  return (
    <li className="qb__editor">
      <label className="qb__editor-field">
        <span className="field__label">题干</span>
        <textarea
          className="textarea qb__editor-text"
          value={text}
          aria-label="题干"
          onChange={(event) => {
            setText(event.target.value);
            onDirty();
          }}
        />
      </label>

      <MasteryCategoryPicks
        variant="form"
        mastery={mastery}
        category={category}
        onChange={(patch) => {
          if (patch.mastery !== undefined) setMastery(patch.mastery);
          if (patch.category !== undefined) setCategory(patch.category);
          onDirty();
        }}
      />

      <label className="qb__editor-field">
        <span className="field__label">我的回答（可空）</span>
        <textarea
          className="textarea qb__editor-answer"
          value={answer}
          aria-label="我的回答"
          placeholder="当时怎么答的、卡在哪 —— 这段以后最值钱"
          onChange={(event) => {
            setAnswer(event.target.value);
            onDirty();
          }}
        />
      </label>

      <div className="qb__editor-actions">
        <button type="button" className="btn btn--small btn--primary" onClick={save} disabled={!text.trim()}>
          保存
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            if (dirty && !warned) {
              setWarned(true);
              return;
            }
            onCancel();
          }}
        >
          取消
        </button>
        {tooLong ? <span className="muted">题干超过 {QUESTION_TEXT_LIMIT} 字，保存后会截断</span> : null}
        {warned && dirty ? <span className="muted">有未保存的修改 —— 再点一次「取消」就丢掉</span> : null}
      </div>
    </li>
  );
}
