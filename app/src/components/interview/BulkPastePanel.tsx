/**
 * R-AI-11 面经整段极速录入（v0.9 / T07b）—— 一个组件、两处入口（Q13 裁决）：
 *
 * 1. **主入口**（QuickNote 的「粘贴整段」模式）：头部四个输入由 QuickNote 受控传入，
 *    AI 对公司/岗位/轮次的建议以 chip 呈现，「点一下填入」，默认不覆盖已填的值；
 * 2. **补录入口**（ExperienceEditor 工具条）：`existingExperienceId` 传进来，
 *    头部只读快照、不新建壳（⌘Z 只移除题目 + 还原 overallNote 原值）。
 *
 * 流程：粘整段 → ⌘Enter /「AI 拆分」→ D13 预览（只发粘贴原文）→ 分层预览
 * （题目 1..N 连续编号 + unmatched 区块默认「留作备注」）→「全部采用」→ 一次 mutate。
 *
 * 为什么不做第二个面经编辑器：仓库内 ExperienceEditor 只此一份（验收 30 会 grep 断言），
 * 这里只做「拆分 → 确认 → 落库」，逐题精修请回编辑器。
 */

import { useEffect, useMemo, useState } from 'react';
import type { BulkAdoptInput } from '../../lib/api';
import type { AppApi } from '../../lib/api';
import type { BulkHeadSuggestion, PreviewField } from '../../ai/types';
import { scenarioPreviewFields } from '../../ai/scenarios';
import { BULK_LIMITS, UNMATCHED_NOTE_PREFIX, type QuestionCategory } from '../../types';
import { CATEGORY_LABEL } from '../../lib/interview';
import { SendPreviewDialog } from '../ai/SendPreviewDialog';

const BULK_PLUGIN_ID = 'builtin:d14-bulk';

export interface BulkPastePanelProps {
  api: AppApi;
  onClose: () => void;
  /** 采用成功后的收尾：主入口 = 关掉整个快记浮层；补录入口 = 只关本面板 */
  onAdopted: () => void;
  /** 主入口：QuickNote 的受控头部（值）。补录入口不传 */
  head?: { companyName: string; jobTitle: string; round: string; interviewDate: string };
  /** 主入口：头部变更回调（AI 建议 chip「点一下填入」走这里） */
  onHeadChange?: (patch: { companyName?: string; jobTitle?: string; round?: string; interviewDate?: string }) => void;
  /** 补录入口：已有面经 id（不新建壳） */
  existingExperienceId?: string;
  /** DOM 隔离用：QuickNote 里传 quicknote-bulk（既有断言零改动） */
  testId?: string;
}

export function BulkPastePanel({
  api,
  onClose,
  onAdopted,
  head,
  onHeadChange,
  existingExperienceId,
  testId = 'bulk-paste-panel',
}: BulkPastePanelProps): JSX.Element {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewField[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [headSuggestion, setHeadSuggestion] = useState<BulkHeadSuggestion | null>(null);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(0);
  const [droppedSegments, setDroppedSegments] = useState<ReadonlySet<number>>(new Set());

  // 本次拆分产出的建议：targetId 恒为 null（接受时才建行），按 pluginId + pending 取
  const suggestions = useMemo(
    () =>
      api.db.aiSuggestions.filter(
        (item) => item.pluginId === BULK_PLUGIN_ID && item.targetId === null && item.status === 'pending',
      ),
    [api.db.aiSuggestions],
  );

  /** 未勾选的题目 id（反向集合：新拆一批默认全选，用户手动取消的记录在这里） */
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    // 新拆一批 → 恢复默认全选；droppedSegments 同理
    setUnchecked(new Set());
    setDroppedSegments(new Set());
  }, [suggestions]);

  const blocked = api.ai.ready ? null : api.ai.readyReason ?? 'AI 服务未配置';
  const overLimit = text.length > BULK_LIMITS.noteChars;
  const checkedCount = suggestions.length - unchecked.size;
  const headCompanyName = head?.companyName ?? '';
  const headJobTitle = head?.jobTitle ?? '';

  const split = async (checked: Record<string, string>): Promise<void> => {
    setPreview(null);
    setRunning(true);
    setError(null);
    const outcome = await api.ai.runScenario({
      scenario: 'd14-bulk',
      targetId: existingExperienceId ?? null,
      checked,
    });
    setRunning(false);
    if (!outcome.ok) {
      setError(outcome.error); // textarea 内容在 state 里，原样保留（验收 28）
      return;
    }
    if (outcome.kind !== 'suggestions') return; // d14-bulk 不会产出报告；窄化给 TS
    setHeadSuggestion(outcome.head ?? null);
    setUnmatched(outcome.unmatched ?? []);
    setTruncated(outcome.truncated ?? 0);
    if ((outcome.unmatched ?? []).length === 0) setDroppedSegments(new Set());
  };

  const startPreview = (): void => {
    if (overLimit) {
      setError(`超过 ${BULK_LIMITS.noteChars} 字 —— 请删减后分段粘贴（不会自动截断）`);
      return;
    }
    setError(null);
    setPreview(
      scenarioPreviewFields('d14-bulk', {
        note: text.trim(),
        companyName: headCompanyName,
        jobTitle: headJobTitle,
      }),
    );
  };

  const adopt = (): void => {
    setError(null);
    const experience = existingExperienceId
      ? api.db.experiences.find((item) => item.id === existingExperienceId)
      : undefined;
    const input: BulkAdoptInput = {
      head: {
        companyName: (experience?.companyName ?? headCompanyName).trim(),
        jobTitle: (experience?.jobTitle ?? headJobTitle).trim() || undefined,
        interviewDate: experience?.interviewDate ?? head?.interviewDate ?? '',
        round: experience ? experience.round ?? null : head?.round ? Number(head.round) : null,
        applicationId: experience?.applicationId ?? null,
      },
      suggestionIds: suggestions.filter((item) => !unchecked.has(item.id)).map((item) => item.id),
      unmatchedKeep: unmatched.filter((_, index) => !droppedSegments.has(index)),
      unmatchedDropped: droppedSegments.size,
      ...(existingExperienceId ? { existingExperienceId } : {}),
    };
    const result = api.adoptBulk(input);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onAdopted();
  };

  /** AI 头部建议 chip：只在用户没填时出现（head 只建议，不覆盖 —— 窄校验第 8 条） */
  const headChip = (label: string, value: string, patch: { companyName?: string; jobTitle?: string; round?: string }) =>
    !blocked && value ? (
      <button type="button" className="link-btn" onClick={() => onHeadChange?.(patch)}>
        AI 建议：{label}「{value}」（点一下填入）
      </button>
    ) : null;

  return (
    <div className="bulk" data-testid={testId}>
      <div className="bulk__bar">
        <span className="bulk__hint">
          把整段面试记录粘进来，AI 拆成一道道题；没识别成题目的原文不会丢。
          {blocked ? ` ${blocked} —— 配好之前只能手动一行一题。` : ''}
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="返回一行一题">
          ✕
        </button>
      </div>

      <label className="field">
        <span className="field__label">
          面经整段原文（≤{BULK_LIMITS.noteChars} 字，现在 {text.length}）
        </span>
        <textarea
          className="textarea"
          rows={8}
          value={text}
          placeholder={'例：\n一面 40 分钟。先问了项目里的缓存设计，然后手写 Promise.all，追问了失败策略。最后反问环节聊了团队分工…'}
          data-testid="bulk-input"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!blocked && text.trim() && !running) startPreview();
            }
          }}
        />
      </label>

      {!head || existingExperienceId ? null : (
        <>
          {!headCompanyName.trim() && headSuggestion?.companyName
            ? headChip('公司', headSuggestion.companyName, { companyName: headSuggestion.companyName })
            : null}
          {!headJobTitle.trim() && headSuggestion?.jobTitle
            ? headChip('岗位', headSuggestion.jobTitle, { jobTitle: headSuggestion.jobTitle })
            : null}
          {headSuggestion?.round && !head?.round ? (
            <button type="button" className="link-btn" onClick={() => onHeadChange?.({ round: String(headSuggestion.round) })}>
              AI 建议：第 {headSuggestion.round} 轮（点一下填入）
            </button>
          ) : null}
        </>
      )}

      {running ? (
        <p className="field__hint" data-testid="bulk-running">
          模型正在拆分…（最多等 60 秒）
        </p>
      ) : null}

      {error ? (
        <p className="field__hint field__hint--danger" data-testid="bulk-error">
          {error}
        </p>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="bulk__result">
          <span className="field__label" data-testid="bulk-selection-count" id="bulk-selection-count">
            已选 {checkedCount}/{suggestions.length} 题 —— 编号按列表顺序生成，不听模型自报
          </span>
          <ul className="bulk__list">
            {suggestions.map((suggestion, index) => {
              const checked = !unchecked.has(suggestion.id);
              const category: QuestionCategory | null = suggestion.meta?.category ?? null;
              return (
                <li key={suggestion.id} className="bulk__item">
                  <label className="bulk__pick">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setUnchecked((prev) => {
                          const next = new Set(prev);
                          if (next.has(suggestion.id)) next.delete(suggestion.id);
                          else next.add(suggestion.id);
                          return next;
                        })
                      }
                    />
                    <span className="bulk__index">#{index + 1}</span>
                  </label>
                  <span className="bulk__text">
                    {suggestion.content}
                    {suggestion.meta?.myAnswer ? (
                      <span className="bulk__answer">我的回答：{suggestion.meta.myAnswer}</span>
                    ) : null}
                  </span>
                  <span className="chip">{category ? CATEGORY_LABEL[category] : '未分类'}</span>
                </li>
              );
            })}
          </ul>

          {unmatched.length > 0 ? (
            <div className="bulk__unmatched" role="group" aria-label="未识别为题目的原文">
              <span className="field__label">未识别为题目的原文（默认留进「整场感受」，取消勾选 = 丢掉）</span>
              <ul>
                {unmatched.map((segment, index) => (
                  <li key={index} className="bulk__unmatched-item">
                    <label className="bulk__pick">
                      <input
                        type="checkbox"
                        checked={!droppedSegments.has(index)}
                        onChange={() =>
                          setDroppedSegments((prev) => {
                            const next = new Set(prev);
                            if (next.has(index)) next.delete(index);
                            else next.add(index);
                            return next;
                          })
                        }
                      />
                      <span className="bulk__text">{segment}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {truncated > 0 ? (
            <p className="field__hint" data-testid="bulk-truncated">
              另有 {truncated} 条（超 50 的题目 / 超 20 段的原文）已省略 —— 题目多请分段粘贴
            </p>
          ) : null}

          <div className="bulk__actions">
            <span className="muted" aria-hidden="true">
              采用后 {UNMATCHED_NOTE_PREFIX.replace('// ', '')} 的段落会附在整场感受末尾
            </span>
            <button
              type="button"
              className="btn btn--primary"
              data-testid="bulk-adopt"
              disabled={checkedCount === 0}
              aria-describedby="bulk-selection-count"
              onClick={adopt}
            >
              全部采用（已选 {checkedCount} 题）
            </button>
          </div>
        </div>
      ) : null}

      {preview ? (
        <SendPreviewDialog
          title="🤖 拆分整段面经"
          pluginId={BULK_PLUGIN_ID}
          baseURL={api.db.settings.ai?.baseURL ?? ''}
          model={api.db.settings.ai?.model ?? ''}
          isLocal={api.db.settings.ai?.isLocal ?? false}
          fields={preview}
          onConfirm={(checked) => void split(checked)}
          onCancel={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
