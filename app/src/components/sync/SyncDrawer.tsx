/**
 * 同步抽屉：① 抓取 → ② 预览 → ③ 确认 → ④ 结果（含暂存区）。
 *
 * 设计约束（架构 §4.2）：
 * - 单向前进：只有「确认合并」这一步会写库；在此之前返回上一步都不产生任何副作用；
 * - 计划完全来自 `api.planSync()`，抽屉里**不做任何重新推导**（去重/映射/默认勾选都在引擎里）；
 * - 解析失败绝不静默：`plan.unparsed` 在 ② 必须显示，未写入的行会进暂存区。
 */

import { useMemo, useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { MergePlan, PlannedRow } from '../../lib/sync/types';
import type { PlatformId, Status } from '../../types';
import { rowSummaryText } from '../../lib/sync/engine';
import { PLATFORM_LABEL } from '../../adapters/registry';
import { STATUS_LABEL } from '../../lib/rules';
import { RiskGate } from './RiskGate';
import { Step1Capture } from './Step1Capture';
import { Step2Preview } from './Step2Preview';
import { Step3Confirm } from './Step3Confirm';
import { StagingList } from './StagingList';

export type SyncStep = 1 | 2 | 3 | 4;

export interface SyncDrawerProps {
  api: AppApi;
  onClose: () => void;
  /** 打开时想直接落在哪一步（TopBar 的「N 条待确认」→ 直接看暂存区） */
  initialStep?: SyncStep;
}

const STEPS: SyncStep[] = [1, 2, 3, 4];

const STEP_LABEL: Record<SyncStep, string> = {
  1: '抓取',
  2: '预览',
  3: '确认',
  4: '结果',
};

export function SyncDrawer(props: SyncDrawerProps) {
  const { api, onClose, initialStep = 1 } = props;
  const riskAckAt = api.db.settings.sync.riskAckAt;

  const [step, setStep] = useState<SyncStep>(initialStep);
  const [text, setText] = useState('');
  const [platform, setPlatform] = useState<PlatformId>(api.db.settings.sync.defaultPlatform);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [rows, setRows] = useState<PlannedRow[]>([]);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => {
    if (!plan) return null;
    const counter = { high: 0, medium: 0, low: 0 };
    for (const row of plan.rows) counter[row.record.overall] += 1;
    return { total: plan.parsedCount, high: counter.high, medium: counter.medium, low: counter.low };
  }, [plan]);

  const checkedCount = rows.filter((row) => isChecked(row)).length;
  /**
   * 会留在暂存区的条数 = 解析失败的条目 + 不会写入的行。
   * ★ QA D1：以前漏了 `plan.unparsed.length`，所以第 ④ 步会显示「没有遗留待归类记录」，
   * 而第 ② 步刚说过「1 条没解析出来，会进待归类」—— 自相矛盾。
   */
  const stagingCount = plan
    ? plan.unparsed.length +
      rows.filter((row) => {
        if (row.kind === 'staged') return true;
        if (isChecked(row)) return false;
        return row.kind === 'conflict' || row.kind === 'new';
      }).length
    : 0;

  const handleParse = (): void => {
    setParsing(true);
    setError(null);
    const outcome = api.planSync({ text, platform, capturedAt: new Date().toISOString() });
    setParsing(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setPlan(outcome.plan);
    // 单独持有一份可变的勾选副本：确认前绝不写库
    setRows(outcome.plan.rows.map((row) => ({ ...row })));
    setStep(2);
  };

  const handleToggle = (key: string, checked: boolean): void => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, checked } : row)));
  };

  const handleCheckOnly = (kind: PlannedRow['kind']): void => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.kind === 'unchanged') return row;
        return { ...row, checked: row.kind === kind };
      }),
    );
  };

  const handleUncheckAll = (): void => {
    setRows((prev) => prev.map((row) => ({ ...row, checked: false })));
  };

  const handleCheckConflicts = (): void => {
    setRows((prev) => prev.map((row) => (row.kind === 'conflict' ? { ...row, checked: true } : row)));
  };

  /**
   * v0.7.2：staged 行的人工修改出口——用户手动指定状态。
   * 行就地升级为 'new' + mappedStatus，确认合并时按新增写入，不再进暂存区。
   * 这是「状态读不出来，需要你归类」的直接解法：与其合并后去暂存区再归类，
   * 不如当场指认。公司/岗位不动（它们参与匹配，改错比不填更糟）。
   */
  const handleManualStatus = (key: string, status: Status): void => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.key !== key || row.kind !== 'staged') return row;
        return {
          ...row,
          kind: 'new',
          mappedStatus: status,
          stagedReason: undefined,
          manuallyResolved: true,
          checked: true,
          warnings: [
            ...row.warnings,
            `状态由你手动指定为「${STATUS_LABEL[status]}」——平台原文没识别出来，写入以你的指认为准`,
          ],
        };
      }),
    );
  };

  const handleCommit = (): void => {
    api.commitSync(rows);
    setStep(4);
  };

  const handleExportPreview = (): void => {
    if (!plan) return;
    const content = renderPlanPreview(plan, rows);
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `同步预览-${plan.platform}-${plan.capturedAt.slice(0, 10)}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    api.toast('预览已导出（只是给你留个底，没有写入任何数据）');
  };

  const reset = (): void => {
    setPlan(null);
    setRows([]);
    setText('');
    setError(null);
    setStep(1);
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer drawer--sync" onClick={(event) => event.stopPropagation()}>
        <header className="drawer__head">
          <div className="drawer__title-wrap">
            <h2 className="drawer__title">同步平台进度</h2>
            <div className="sync__steps">
              {STEPS.map((item) => (
                <span
                  key={item}
                  className={
                    item === step
                      ? 'sync__step-dot sync__step-dot--active'
                      : item < step
                        ? 'sync__step-dot sync__step-dot--done'
                        : 'sync__step-dot'
                  }
                >
                  {item} {STEP_LABEL[item]}
                </span>
              ))}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="drawer__body">
          {!riskAckAt ? (
            <RiskGate api={api} />
          ) : (
            <>
              {step === 1 ? (
                <Step1Capture
                  text={text}
                  onText={setText}
                  platform={platform}
                  onPlatform={setPlatform}
                  onParse={handleParse}
                  parsing={parsing}
                  error={error}
                  summary={summary}
                  riskAckAt={riskAckAt}
                />
              ) : null}

              {step === 2 && plan ? <Step2Preview plan={plan} /> : null}

              {step === 3 && plan ? (
                <Step3Confirm
                  plan={{ ...plan, rows }}
                  onToggle={handleToggle}
                  onCheckOnly={handleCheckOnly}
                  onUncheckAll={handleUncheckAll}
                  onCheckConflicts={handleCheckConflicts}
                  onManualStatus={handleManualStatus}
                />
              ) : null}

              {step === 4 ? (
                <>
                  <section className="sync__step">
                    <div className="sync__step-head">
                      <h3 className="sync__step-title">④ 已合并</h3>
                    </div>
                    <div className="notice notice--ok">
                      写入 {checkedCount} 条
                      {stagingCount > 0 ? ` · ${stagingCount} 条留在暂存区待归类` : ' · 没有遗留待归类记录'}
                      。刚才的 toast 里有「撤销」，点一下可以整体还原（逐字段回到合并前）。
                    </div>
                    {plan ? (
                      <p className="muted">
                        本次识别 {plan.parsedCount} 条，来源 {PLATFORM_LABEL[plan.platform]}，
                        抓取时间 {plan.capturedAt.slice(0, 16).replace('T', ' ')}。
                      </p>
                    ) : null}
                  </section>
                  <StagingList
                    items={api.db.staging}
                    onResolve={(id, status) => api.resolveStaged(id, status)}
                    onClear={() => api.clearStaging()}
                    onManualAdd={() => api.openNew()}
                  />
                </>
              ) : null}
            </>
          )}
        </div>

        <footer className="sync__foot">
          <div className="sync__foot-left">
            {step > 1 && step < 4 ? (
              <button type="button" className="btn btn--small" onClick={() => setStep((step - 1) as SyncStep)}>
                ← 上一步
              </button>
            ) : null}
            {step === 4 ? (
              <button type="button" className="btn btn--small" onClick={reset}>
                ↻ 再同步一次
              </button>
            ) : null}
          </div>
          <div className="sync__foot-right">
            <button type="button" className="btn btn--small" onClick={onClose}>
              放弃
            </button>
            {plan ? (
              <button type="button" className="btn btn--small" onClick={handleExportPreview}>
                只导出预览
              </button>
            ) : null}
            {step === 2 ? (
              <button type="button" className="btn btn--small btn--primary" onClick={() => setStep(3)}>
                下一步：逐项确认 →
              </button>
            ) : null}
            {step === 3 ? (
              <button type="button" className="btn btn--small btn--primary" onClick={handleCommit}>
                确认合并
              </button>
            ) : null}
          </div>
        </footer>
      </aside>
    </div>
  );
}

/** `checked` 为 undefined 时退回引擎给的默认值（UI 绝不重新推导） */
function isChecked(row: PlannedRow): boolean {
  if (row.kind === 'unchanged') return false;
  return row.checked ?? row.defaultChecked;
}

function renderPlanPreview(plan: MergePlan, rows: PlannedRow[]): string {
  const lines: string[] = [
    `# 同步预览 · ${PLATFORM_LABEL[plan.platform]}`,
    '',
    `- 抓取时间：${plan.capturedAt}`,
    `- 识别：${plan.parsedCount} 条（新增 ${plan.counts.new} / 更新 ${plan.counts.update} / 无变化 ${plan.counts.unchanged} / 冲突 ${plan.counts.conflict} / 待归类 ${plan.counts.staged}）`,
    `- 本次勾选：${rows.filter((row) => isChecked(row)).length} 条`,
    '',
    '| 公司 | 岗位 | 判定 | 说明 | 勾选 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of plan.rows) {
    const summaryText = rowSummaryText(row).replace(/\|/g, '\\|');
    lines.push(
      `| ${row.record.companyName} | ${row.record.jobTitle || '—'} | ${row.kind} | ${summaryText} | ${
        isChecked(row) ? '✓' : '—'
      } |`,
    );
  }
  if (plan.unparsed.length > 0) {
    lines.push('', '## 没解析出来的条目', '');
    for (const item of plan.unparsed) {
      lines.push(`- ${item.reason}：${item.rawSnippet.replace(/\n/g, ' ')}`);
    }
  }
  if (plan.rows.length > 0 && plan.counts.staged > 0) {
    lines.push(
      '',
      '> 待归类的行不会写入投递，会进暂存区；确认合并后可以在同步面板里逐条指定阶段。',
    );
  }
  return lines.join('\n');
}

/** 供 Step2 的差异文案复用的状态名（避免各组件各写一份） */
export function statusTextOf(status: keyof typeof STATUS_LABEL | null): string {
  return status ? STATUS_LABEL[status] : '—';
}
