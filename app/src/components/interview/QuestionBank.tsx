/**
 * 题库：按场折叠的概览卡 + 5 维筛选（公司 / 分类 / 掌握度 / 是否到期 / 关键词）+ 行内编辑。
 *
 * 排序**只**用 `lib/interview.ts` 的 `sortQuestionsForReview`（单测覆盖），
 * 组件里不许再写一套 sort —— 否则「题库顺序」和「复习队列顺序」会慢慢分叉。
 *
 * v0.9 / T-QB ②③：
 * - ② 一屏 20 张卡全是重复的公司/日期头 → 改成「每场一张概览卡」，默认收起，
 *   卡内预览前 2 题；展开才逐题渲染。筛选仍然先过题，筛完再按场分组（某场 0 命中 → 整卡不渲染）。
 * - ③ 每题可改：展开后行尾「编辑」进行内编辑态（一次只允许一行），
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

/** 展开一场时最多渲染这么多行（防止复制粘贴整包数据把 DOM 撑爆） */
const PAGE_SIZE = 60;
/** 收起时卡内预览几题 */
const PREVIEW_SIZE = 2;

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
  /** 正在编辑的题（一次只允许一行，防误触多处同时编辑） */
  const [editingId, setEditingId] = useState<string | null>(null);

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

  const sorted = useMemo(() => reviewQueue(filtered, nowIso), [filtered, nowIso]);
  const dueCount = db.questions.filter((question) => isDue(question, today)).length;

  /**
   * 分组：单次 O(N) 扫描（不在场次里再 filter 一遍 —— 那是 O(N×场次)）。
   * 组内顺序沿用 sorted 的顺序，所以「不会的先看」在每张卡里也成立。
   */
  const groups = useMemo(() => {
    const byExperience = new Map<string, Question[]>();
    for (const question of sorted) {
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
    return result;
  }, [sorted, experienceById]);

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

  const toggleGroup = (experienceId: string): void => {
    setExpanded((prev) => ({ ...prev, [experienceId]: !prev[experienceId] }));
    // 收起时光标所在的编辑态跟着结束 —— 否则「保存」成了一个找不到行号的悬空按钮
    setEditingId((current) => {
      if (!current) return current;
      const target = db.questions.find((question) => question.id === current);
      return target && target.experienceId === experienceId ? null : current;
    });
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
        共 {db.questions.length} 题 · 当前筛选 {sorted.length} 题 · {groups.length} 场 · 到期 {dueCount} 题（按「不会的先看」排序）
      </p>

      {sorted.length === 0 ? (
        <div className="empty-block">
          <div className="empty-block__emoji">🔍</div>
          <div className="empty-block__title">这个筛选下没有题</div>
          <p className="empty-block__text">把「只看到期」关掉，或者换一家公司看看。</p>
        </div>
      ) : (
        <ul className="qb__list">
          {groups.map((group) => {
            const open = Boolean(expanded[group.experienceId]);
            const rows = group.questions.slice(0, PAGE_SIZE);
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

                {open ? (
                  <ul className="qb__rows">
                    {rows.map((question) =>
                      question.id === editingId ? (
                        <QuestionEditor
                          key={question.id}
                          question={question}
                          onSave={(patch) => {
                            api.editQuestion(question.id, patch);
                            setEditingId(null);
                          }}
                          onCancel={() => setEditingId(null)}
                        />
                      ) : (
                        <QuestionRow
                          key={question.id}
                          question={question}
                          today={today}
                          nowIso={nowIso}
                          onEdit={() => setEditingId(question.id)}
                        />
                      ),
                    )}
                  </ul>
                ) : (
                  <div className="qb__preview">
                    {group.questions.slice(0, PREVIEW_SIZE).map((question) => (
                      <p key={question.id} className="qb__preview-line">
                        <span className={`qb__mastery qb__mastery--${question.mastery}`}>
                          {MASTERY_LABEL[question.mastery]}
                        </span>
                        <span className="qb__preview-text">{question.text}</span>
                      </p>
                    ))}
                  </div>
                )}

                {open && group.questions.length > PAGE_SIZE ? (
                  <p className="muted qb__group-more">
                    这一场只显示前 {PAGE_SIZE} 题（共 {group.questions.length}）。用上面的搜索缩小范围。
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
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

/** 行内编辑态：题干 / 掌握度 / 分类 / 我的回答（可空），保存一次 mutate + 一条撤销栈 */
function QuestionEditor(props: {
  question: Question;
  onSave: (patch: Partial<Question>) => void;
  onCancel: () => void;
}) {
  const { question, onSave, onCancel } = props;
  const [text, setText] = useState(question.text);
  const [mastery, setMastery] = useState<Mastery>(question.mastery);
  const [category, setCategory] = useState<QuestionCategory | null>(question.category);
  const [answer, setAnswer] = useState(question.myAnswer ?? '');

  const save = (): void => {
    const next = text.trim();
    if (!next) return;
    onSave({ text: next, mastery, category, myAnswer: answer.trim() || undefined });
  };

  return (
    <li className="qb__editor">
      <label className="qb__editor-field">
        <span className="field__label">题干</span>
        <textarea
          className="textarea qb__editor-text"
          value={text}
          aria-label="题干"
          onChange={(event) => setText(event.target.value)}
        />
      </label>

      <MasteryCategoryPicks
        variant="form"
        mastery={mastery}
        category={category}
        onChange={(patch) => {
          if (patch.mastery !== undefined) setMastery(patch.mastery);
          if (patch.category !== undefined) setCategory(patch.category);
        }}
      />

      <label className="qb__editor-field">
        <span className="field__label">我的回答（可空）</span>
        <textarea
          className="textarea qb__editor-answer"
          value={answer}
          aria-label="我的回答"
          placeholder="当时怎么答的、卡在哪 —— 这段以后最值钱"
          onChange={(event) => setAnswer(event.target.value)}
        />
      </label>

      <div className="qb__editor-actions">
        <button type="button" className="btn btn--small btn--primary" onClick={save} disabled={!text.trim()}>
          保存
        </button>
        <button type="button" className="btn btn--small" onClick={onCancel}>
          取消
        </button>
      </div>
    </li>
  );
}
