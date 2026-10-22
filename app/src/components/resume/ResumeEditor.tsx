/**
 * 简历编辑器 = **表单 + 模板 + 预览** 三栏并排（PRD §8 / ARCH §1.4）。
 *
 * 三条必须理解的连线，改这个文件前先看一遍：
 *
 * 1. **草稿只有一份，住在 `useResumeDraft` 里**（不是 useState）。
 *    左边表单改的是它、右边预览画的是它、400 ms 后落库的也是它 ——
 *    预览**不等落库**，否则「改一个字 → 等半秒 → 纸上才变」会让人以为没生效。
 * 2. **任何「以库为准」的动作之前都要 flush**：打印、存版本、以此版本为草稿、
 *    切模板。否则防抖窗口里那 400 ms 的输入会被外部内容覆盖（A-07 的老坑）。
 * 3. **切模板只 flush 不改内容**：`ensureSections` 是 append-only，
 *    切走再切回来 content 是超集，别的模板的字段都还在。
 */

import type { AppApi } from '../../lib/api';
import type { Resume, TemplateId } from '../../types';
import { sectionsOf } from '../../resume/templates';
import { useResumeDraft } from './useResumeDraft';
import { SchemaForm } from './SchemaForm';
import { TemplatePicker } from './TemplatePicker';
import { A4Preview } from './A4Preview';
import { PrintButton } from './PrintButton';
import { VersionMenu } from './VersionMenu';

export function ResumeEditor({ api, resume }: { api: AppApi; resume: Resume }) {
  const { draft, update, flush } = useResumeDraft({
    content: resume.content,
    onCommit: (next) => api.updateResumeContent(resume.id, next),
  });

  const sections = sectionsOf(resume.templateId);

  /**
   * 切模板：先 flush 再切。
   * 顺序反了就是「刚打的最后一行没进库，切模板时被旧内容覆盖」——
   * 这个 bug 在测试里很难复现，在用户手里是「我明明写了」。
   */
  const switchTemplate = (templateId: TemplateId): void => {
    flush();
    api.resume.setTemplate(resume.id, templateId);
  };

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
        </div>
      </div>

      <VersionMenu api={api} resume={resume} onBeforeSave={flush} />
    </div>
  );
}
