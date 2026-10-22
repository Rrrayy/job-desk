/**
 * 简历编辑器 = **表单 + 模板 + 预览** 三栏并排（PRD §8 / ARCH §1.4）。
 *
 * 四条必须理解的连线，改这个文件前先看一遍：
 *
 * 1. **草稿只有一份，住在 `useResumeDraft` 里**（不是 useState）。
 *    左边表单改的是它、右边预览画的是它、400 ms 后落库的也是它 ——
 *    预览**不等落库**，否则「改一个字 → 等半秒 → 纸上才变」会让人以为没生效。
 * 2. **任何「以库为准」的动作之前都要 flush**：打印、存版本、以此版本为草稿、
 *    切模板、AI 写回。否则防抖窗口里那 400 ms 的输入会被外部内容覆盖（A-07 的老坑）。
 *    AI 那条由 `registerResumeFlush` 把 flush 注册给 App（建议接受在 App 层发生）。
 * 3. **切模板只 flush 不改内容**：`ensureSections` 是 append-only，
 *    切走再切回来 content 是超集，别的模板的字段都还在。
 * 4. **AI 模块列表来自本地 draft**（不是库里的 resume.content）：
 *    用户刚打的字还没落库也能被 AI 看到 —— 但写回前仍会 flush，顺序不能反。
 */

import { useEffect, useMemo, useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { Resume, TemplateId } from '../../types';
import { sectionsOf } from '../../resume/templates';
import { resumeModules } from '../../ai/context';
import { useResumeDraft } from './useResumeDraft';
import { SchemaForm } from './SchemaForm';
import { TemplatePicker } from './TemplatePicker';
import { A4Preview } from './A4Preview';
import { PrintButton } from './PrintButton';
import { VersionMenu } from './VersionMenu';
import { AiScenarioPanel } from '../ai/AiScenarioPanel';
import { ReportCard } from './ReportCard';

export function ResumeEditor({ api, resume }: { api: AppApi; resume: Resume }) {
  const { draft, update, flush } = useResumeDraft({
    content: resume.content,
    onCommit: (next) => api.updateResumeContent(resume.id, next),
  });

  const sections = sectionsOf(resume.templateId);
  /** AI 入口（润色 / 诊断）。面板与模块列表都挂在编辑器里 —— 只有这里知道本地 draft */
  const [aiScenario, setAiScenario] = useState<'d19-polish' | 'd19-diag' | null>(null);

  /**
   * 把 flush 注册给 App：AI 建议的「接受」发生在 App 层（单次 mutate + 撤销点），
   * 但待落库的草稿活在这里。卸载时注销，免得把 flush 打到别的简历上。
   */
  useEffect(() => {
    api.registerResumeFlush(flush);
    return () => api.registerResumeFlush(null);
  }, [api, flush]);

  /** 模块列表跟本地 draft 走：刚打没落库的字段也要能被选中发给 AI */
  const modules = useMemo(() => resumeModules({ templateId: resume.templateId, content: draft }), [
    resume.templateId,
    draft,
  ]);

  /** 最新一份诊断报告（重新生成会顶掉旧的，capReports 每 target 只留 3 份） */
  const latestReport = useMemo(() => {
    const list = (api.db.aiReports ?? [])
      .filter((report) => report.targetType === 'resume_diagnosis' && report.targetId === resume.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return list[0] ?? null;
  }, [api.db.aiReports, resume.id]);

  /**
   * 切模板：先 flush 再切。
   * 顺序反了就是「刚打的最后一行没进库，切模板时被旧内容覆盖」——
   * 这个 bug 在测试里很难复现，在用户手里是「我明明写了」。
   */
  const switchTemplate = (templateId: TemplateId): void => {
    flush();
    api.resume.setTemplate(resume.id, templateId);
  };

  const aiReady = api.ai.ready;

  return (
    <div className="resume-editor">
      <header className="resume-editor__bar">
        <button type="button" className="btn btn--small btn--ghost" onClick={() => api.resume.close()}>
          ← 全部简历
        </button>
        <h2 className="resume-editor__name">{resume.name}</h2>
        <span className="resume-editor__meta">
          {sections.length} 个板块 · 改完不用手动保存（停止输入 0.4 秒自动存草稿）
        </span>
        <div className="resume-editor__acts">
          {/* 22.8 KB 里 print/A4 那部分由这一行激活（T03 写好的编排，T05 才是它的消费方） */}
          <PrintButton onBeforePrint={flush} />
          <button
            type="button"
            className="btn btn--small btn--ghost"
            disabled={!aiReady}
            title={aiReady ? '选中一个板块让 AI 重写' : api.ai.readyReason ?? 'AI 服务未配置'}
            onClick={() => setAiScenario('d19-polish')}
          >
            ✨ AI 润色
          </button>
          <button
            type="button"
            className="btn btn--small btn--ghost"
            disabled={!aiReady}
            title={aiReady ? '按目标岗位诊断 1–3 个板块' : api.ai.readyReason ?? 'AI 服务未配置'}
            onClick={() => setAiScenario('d19-diag')}
          >
            🤖 AI 诊断
          </button>
        </div>
      </header>

      <div className="resume-editor__panes">
        <div className="resume-editor__col resume-editor__col--tpl">
          <TemplatePicker value={resume.templateId} onChange={switchTemplate} />
        </div>
        <div className="resume-editor__col resume-editor__col--form">
          <SchemaForm sections={sections} content={draft} onChange={update} />
        </div>
        <div className="resume-editor__col resume-editor__col--paper">
          <A4Preview content={draft} templateId={resume.templateId} />
          {latestReport ? <ReportCard report={latestReport} /> : null}
        </div>
      </div>

      <VersionMenu api={api} resume={resume} onBeforeSave={flush} />

      {aiScenario ? (
        <AiScenarioPanel
          api={api}
          scenario={aiScenario}
          targetId={resume.id}
          modules={modules}
          onClose={() => setAiScenario(null)}
        />
      ) : null}
    </div>
  );
}
