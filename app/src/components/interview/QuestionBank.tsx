/**
 * 题库：5 维筛选（公司 / 分类 / 掌握度 / 是否到期 / 关键词）+ 掌握度排序 + 到期标红。
 *
 * 排序**只**用 `lib/interview.ts` 的 `sortQuestionsForReview`（单测覆盖），
 * 组件里不许再写一套 sort —— 否则「题库顺序」和「复习队列顺序」会慢慢分叉。
 */

import { useMemo, useState } from 'react';
import type { Mastery, Question, QuestionCategory } from '../../types';
import type { AppApi } from '../../lib/api';
import {
  CATEGORY_LABEL,
  CATEGORY_OPTIONS,
  MASTERY_LABEL,
  daysUntilReview,
  isDue,
  reviewQueue,
} from '../../lib/interview';
import { toDateISO } from '../../lib/date';
import { ReviewCards } from './ReviewCards';

export interface QuestionBankProps {
  api: AppApi;
  onRecord: () => void;
}

type MasteryFilter = 'all' | Mastery;

const PAGE_SIZE = 60;

export function QuestionBank({ api, onRecord }: QuestionBankProps) {
  const { db } = api;
  const [company, setCompany] = useState<string>('all');
  const [category, setCategory] = useState<'all' | QuestionCategory>('all');
  const [mastery, setMastery] = useState<MasteryFilter>('all');
  const [onlyDue, setOnlyDue] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'list' | 'review'>('list');
  const [reviewIds, setReviewIds] = useState<string[] | null>(null);

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
  const visible = sorted.slice(0, PAGE_SIZE);
  const dueCount = db.questions.filter((question) => isDue(question, today)).length;

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
        共 {db.questions.length} 题 · 当前筛选 {sorted.length} 题 · 到期 {dueCount} 题（按「不会的先看」排序）
      </p>

      {sorted.length === 0 ? (
        <div className="empty-block">
          <div className="empty-block__emoji">🔍</div>
          <div className="empty-block__title">这个筛选下没有题</div>
          <p className="empty-block__text">把「只看到期」关掉，或者换一家公司看看。</p>
        </div>
      ) : (
        <ul className="qb__list">
          {visible.map((question) => (
            <QuestionRow
              key={question.id}
              question={question}
              companyName={experienceById.get(question.experienceId)?.companyName ?? '未知公司'}
              today={today}
              nowIso={nowIso}
            />
          ))}
        </ul>
      )}

      {sorted.length > PAGE_SIZE ? (
        <p className="muted">只显示前 {PAGE_SIZE} 题（共 {sorted.length}）。用上面的筛选缩小范围。</p>
      ) : null}
    </div>
  );
}

function QuestionRow(props: {
  question: Question;
  companyName: string;
  today: string;
  nowIso: string;
}) {
  const { question, companyName, today, nowIso } = props;
  const due = isDue(question, today);
  const days = daysUntilReview(question, nowIso);

  return (
    <li className={`qb__item ${due ? 'qb__item--due' : ''}`}>
      <div className="qb__item-head">
        <span className="qb__item-company">{companyName}</span>
        <span className="chip">{question.category ? CATEGORY_LABEL[question.category] : '未分类'}</span>
        <span className={`qb__mastery qb__mastery--${question.mastery}`}>{MASTERY_LABEL[question.mastery]}</span>
        {due ? <span className="qb__due-flag">今天该复习</span> : null}
      </div>
      <p className="qb__item-text">{question.text}</p>
      <div className="qb__item-foot">
        <span className="muted">
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
      </div>
    </li>
  );
}
