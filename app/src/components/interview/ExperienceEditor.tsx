/**
 * 面经编辑器：把「快记」时来不及写的东西补上 —— 我当时怎么答的、下次怎么改、这道题属于哪类。
 *
 * 面经最值钱的字段是 `myAnswer`（PRD §C.3），所以它占据每张卡片最大的面积，
 * 而且不做富文本、不做自动保存提示噪音：失焦即存。
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../../lib/api';
import type {
  ExperienceResult,
  Mastery,
  Question,
  QuestionCategory,
  RootCause,
} from '../../types';
import {
  CATEGORY_LABEL,
  CATEGORY_OPTIONS,
  EXPERIENCE_RESULT_LABEL,
  MASTERY_LABEL,
  ROOT_CAUSE_LABEL,
  ROOT_CAUSE_OPTIONS,
  questionsOf,
} from '../../lib/interview';
import { clampText } from '../../lib/budget';
import { AiScenarioPanel } from '../ai/AiScenarioPanel';
import { BulkPastePanel } from './BulkPastePanel';
import { CLS } from '../../lib/classTokens';

const ANSWER_LIMIT = 5000;
const NOTE_LIMIT = 3000;

export interface ExperienceEditorProps {
  api: AppApi;
  experienceId: string;
  onClose: () => void;
}

export function ExperienceEditor({ api, experienceId, onClose }: ExperienceEditorProps) {
  const experience = api.db.experiences.find((item) => item.id === experienceId);
  const questions = useMemo(
    () => (experience ? questionsOf(api.db.questions, experience.id) : []),
    [api.db.questions, experience],
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** v0.8 / D14：AI 整理面板（浮层，只在用户点了入口后才挂载） */
  const [aiOpen, setAiOpen] = useState(false);
  /** v0.9 / R-AI-11：整段补录面板（同一 BulkPastePanel 组件的第二个入口，验收 30） */
  const [bulkOpen, setBulkOpen] = useState(false);

  if (!experience) {
    return (
      <div className={CLS.H} onClick={onClose}>
        <aside className="drawer" onClick={(event) => event.stopPropagation()}>
          <header className={CLS.K}>
            <h2 className={CLS.I}>面经不见了</h2>
            <button type="button" className={CLS.m} onClick={onClose} title="关闭" aria-label="关闭">
              ✕
            </button>
          </header>
          <div className={CLS.J}>
            <p className={CLS.d}>这条面经可能已经被删掉了。</p>
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className={CLS.H} onClick={onClose}>
      <aside className="drawer drawer--exp" onClick={(event) => event.stopPropagation()}>
        <header className={CLS.K}>
          <div className={CLS.ah}>
            <h2 className={CLS.I}>
              {experience.companyName}
              {experience.jobTitle ? ` · ${experience.jobTitle}` : ''}
            </h2>
            <div className="drawer__chips">
              <span className="chip">{experience.interviewDate}</span>
              {experience.round ? <span className="chip">第 {experience.round} 轮</span> : null}
              <span className="chip">{EXPERIENCE_RESULT_LABEL[experience.result]}</span>
              {experience.source === 'community' ? <span className="chip">社区导入</span> : null}
            </div>
          </div>
          <button type="button" className={CLS.m} onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            ✕
          </button>
        </header>

        <div className={CLS.J}>
          <section className={CLS.n}>
            <div className={CLS.w}>
              <h3 className={CLS.i}>这场面试</h3>
              <button
                type="button"
                className={CLS.k}
                onClick={() => {
                  api.exportExperienceMarkdown([experience], { desensitize: true });
                }}
              >
                导出这篇 Markdown
              </button>
            </div>

            <div className={CLS.X}>
              <label className={CLS.e}>
                <span className={CLS.a}>公司</span>
                <input
                  className={CLS.f}
                  defaultValue={experience.companyName}
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (value && value !== experience.companyName) api.updateExperience(experience.id, { companyName: value });
                  }}
                />
              </label>
              <label className={CLS.e}>
                <span className={CLS.a}>岗位</span>
                <input
                  className={CLS.f}
                  defaultValue={experience.jobTitle ?? ''}
                  onBlur={(event) => api.updateExperience(experience.id, { jobTitle: event.target.value.trim() || undefined })}
                />
              </label>
              <label className={CLS.au}>
                <span className={CLS.a}>轮次</span>
                <input
                  className={CLS.f}
                  type="number"
                  min={1}
                  defaultValue={experience.round ?? ''}
                  onBlur={(event) =>
                    api.updateExperience(experience.id, {
                      round: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                />
              </label>
              <label className={CLS.e}>
                <span className={CLS.a}>面试日期</span>
                <input
                  className={CLS.f}
                  type="date"
                  defaultValue={experience.interviewDate}
                  onBlur={(event) => {
                    const value = event.target.value;
                    if (value) api.updateExperience(experience.id, { interviewDate: value });
                  }}
                />
              </label>
              <label className={CLS.e}>
                <span className={CLS.a}>结果</span>
                <select
                  className={CLS.D}
                  value={experience.result}
                  onChange={(event) =>
                    api.updateExperience(experience.id, { result: event.target.value as ExperienceResult })
                  }
                >
                  {(Object.keys(EXPERIENCE_RESULT_LABEL) as ExperienceResult[]).map((result) => (
                    <option key={result} value={result}>
                      {EXPERIENCE_RESULT_LABEL[result]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className={CLS.g}>
              <span className={CLS.a}>整场感受（≤{NOTE_LIMIT} 字）</span>
              <textarea
                className="textarea exp__overall"
                defaultValue={experience.overallNote ?? ''}
                placeholder="面试节奏、面试官关注点、自己最大的问题…"
                onBlur={(event) => {
                  const clamped = clampText(event.target.value, NOTE_LIMIT);
                  api.updateExperience(experience.id, { overallNote: clamped.text || undefined });
                  if (clamped.truncated) api.toast(`超出 ${NOTE_LIMIT} 字，已截断保存`);
                }}
              />
            </label>
          </section>

          <section className={CLS.n}>
            <div className={CLS.w}>
              <h3 className={CLS.i}>题目（{questions.length}）</h3>
              <span className={CLS.d}>失焦即保存</span>
            </div>

            {/*
              D14 入口。AI 未配置时置灰 + 就地说明原因（R-AI-5）——
              不用「点了才告诉你没配」，更不弹错误框。
            */}
            <div className={CLS.p}>
              <button
                type="button"
                className={CLS.b}
                data-testid="ai-d14-entry"
                disabled={!api.ai.ready}
                onClick={() => setAiOpen(true)}
              >
                🤖 用 AI 整理这段面经
              </button>
              <button
                type="button"
                className={CLS.b}
                data-testid="bulk-paste-entry"
                disabled={!api.ai.ready}
                title={api.ai.ready ? '粘一整段记录，AI 拆成题补进这场面经' : api.ai.readyReason ?? 'AI 未配置'}
                onClick={() => setBulkOpen(true)}
              >
                📋 继续粘贴整段
              </button>
              <span className={CLS.c}>
                {api.ai.ready ? '粘贴一段零散记录，AI 拆成题，逐题勾选才写入' : api.ai.readyReason}
              </span>
            </div>

            {questions.length === 0 ? (
              <p className={CLS.d}>这场还没记题。关掉这个窗口，点「＋ 记面经」一行一题补上。</p>
            ) : (
              <ul className="exp__question-list">
                {questions.map((question, index) => (
                  <QuestionEditor key={question.id} question={question} index={index} api={api} />
                ))}
              </ul>
            )}
          </section>

          <section className={CLS.aS}>
            <h3 className={CLS.i}>删除这场面经</h3>
            {confirmDelete ? (
              <div className={CLS.p}>
                <span className={CLS.d}>会连带删掉这场记的 {questions.length} 道题。</span>
                <button
                  type="button"
                  className={CLS.V}
                  onClick={() => {
                    api.deleteExperience(experience.id);
                    api.toast('面经已删除');
                    onClose();
                  }}
                >
                  确认删除
                </button>
                <button type="button" className={CLS.b} onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button type="button" className={CLS.b} onClick={() => setConfirmDelete(true)}>
                删除这场
              </button>
            )}
          </section>
        </div>
      </aside>

      {aiOpen ? (
        <AiScenarioPanel api={api} scenario="d14" targetId={experience.id} onClose={() => setAiOpen(false)} />
      ) : null}

      {bulkOpen ? (
        <div className={CLS.H} onClick={() => setBulkOpen(false)}>
          <aside className="drawer drawer--exp" onClick={(event) => event.stopPropagation()}>
            <header className={CLS.K}>
              <h2 className={CLS.I}>整段补录 —— {experience.companyName}</h2>
              <button type="button" className={CLS.m} onClick={() => setBulkOpen(false)} aria-label="关闭">
                ✕
              </button>
            </header>
            <div className={CLS.J}>
              <BulkPastePanel
                api={api}
                existingExperienceId={experience.id}
                onClose={() => setBulkOpen(false)}
                onAdopted={() => setBulkOpen(false)}
              />
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function QuestionEditor({ question, index, api }: { question: Question; index: number; api: AppApi }) {
  const [open, setOpen] = useState(false);

  return (
    <li className="exp__question">
      <button type="button" className="exp__question-head" onClick={() => setOpen((prev) => !prev)}>
        <span className="exp__question-index">Q{index + 1}</span>
        <span className="exp__question-text">{question.text}</span>
        <span className="exp__question-state">
          {question.mastery === 0 ? '不会' : MASTERY_LABEL[question.mastery]}
          {question.myAnswer ? ' · 有回答' : ''}
        </span>
        <span className="exp__question-toggle">{open ? '收起' : '补全'}</span>
      </button>

      {open ? (
        <div className="exp__question-body">
          <div className="exp__question-row">
            <label className={CLS.e}>
              <span className={CLS.a}>分类</span>
              <select
                className={CLS.q}
                value={question.category ?? ''}
                onChange={(event) =>
                  api.updateQuestion(question.id, {
                    category: event.target.value ? (event.target.value as QuestionCategory) : null,
                  })
                }
              >
                <option value="">未分类</option>
                {CATEGORY_OPTIONS.map((item) => (
                  <option key={item} value={item}>
                    {CATEGORY_LABEL[item]}
                  </option>
                ))}
              </select>
            </label>
            <label className={CLS.au}>
              <span className={CLS.a}>难度</span>
              <select
                className={CLS.q}
                value={question.difficulty}
                onChange={(event) =>
                  api.updateQuestion(question.id, { difficulty: Number(event.target.value) as 1 | 2 | 3 })
                }
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            <label className={CLS.e}>
              <span className={CLS.a}>掌握度</span>
              <select
                className={CLS.q}
                value={question.mastery}
                onChange={(event) =>
                  api.updateQuestion(question.id, { mastery: Number(event.target.value) as Mastery })
                }
              >
                <option value={0}>{MASTERY_LABEL[0]}</option>
                <option value={1}>{MASTERY_LABEL[1]}</option>
                <option value={2}>{MASTERY_LABEL[2]}</option>
              </select>
            </label>
            <label className={CLS.e}>
              <span className={CLS.a}>挂的原因</span>
              <select
                className={CLS.q}
                value={question.rootCause ?? ''}
                onChange={(event) =>
                  api.updateQuestion(question.id, {
                    rootCause: event.target.value ? (event.target.value as RootCause) : undefined,
                  })
                }
              >
                <option value="">没标</option>
                {ROOT_CAUSE_OPTIONS.map((item) => (
                  <option key={item} value={item}>
                    {ROOT_CAUSE_LABEL[item]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className={CLS.g}>
            <span className={CLS.a}>我当时怎么答的（≤{ANSWER_LIMIT} 字）</span>
            <textarea
              className={CLS.T}
              defaultValue={question.myAnswer ?? ''}
              placeholder="写出你当时的真实回答 —— 这段是以后复习最值钱的东西"
              onBlur={(event) => {
                const clamped = clampText(event.target.value, ANSWER_LIMIT);
                api.updateQuestion(question.id, { myAnswer: clamped.text || undefined });
                if (clamped.truncated) api.toast(`超出 ${ANSWER_LIMIT} 字，已截断保存`);
              }}
            />
          </label>

          <label className={CLS.g}>
            <span className={CLS.a}>下次怎么改（一句话）</span>
            <input
              className={CLS.f}
              defaultValue={question.nextTime ?? ''}
              placeholder="例：先说结论，再补 Promise.all 的失败策略"
              onBlur={(event) => api.updateQuestion(question.id, { nextTime: event.target.value.trim() || undefined })}
            />
          </label>

          <div className="exp__question-actions">
            <button type="button" className={CLS.aq} onClick={() => api.deleteQuestion(question.id)}>
              删掉这题
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
