/**
 * AI 场景的上下文装配（v0.9 / T07）。
 *
 * 为什么单独一层：D15 的取值逻辑原本内联在 `AiScenarioPanel` 的配置函数里，
 * D20 要的就是同一份上下文 —— 不抽出来就是复制粘贴，两处取值迟早漂移。
 * 抽出来之后「D15 与 D20 同入参同输出」可以用一行断言钉死（行为等价）。
 *
 * `resumeModules` 是模块选择器的数据源，也是**联系方式的结构性边界**：
 * basics 板块（姓名/电话/邮箱/城市/照片）根本不会成为模块 —— 联系方式不是
 * 「默认不勾」，是「没有勾选框」，预览里连那个开关都不存在。
 */

import type { Application, DB, Resume } from '../types';
import type { AiResumeModule } from './types';
import { INTERVIEW_KIND_LABEL, STATUS_LABEL } from '../lib/rules';
import { companyFullName } from '../lib/util';
import { sectionsOf } from '../resume/templates';
import { FIELD_META, type FieldKey } from '../resume/templates/base';

/** 单模块文本上限（合计 ≤4000 字由面板在勾选时控制，这里只兜单模块的底） */
const MODULE_CHARS = 1600;
/** 润色主字段候选顺序：职责与成果是润色的第一目标，其余文本字段兜底 */
const PRIMARY_KEYS: readonly FieldKey[] = ['description', 'customText', 'skillsText'];

/** D15 / D20 共用的投递上下文（与 v0.8 D15 面板里那份取值逐字段等价） */
export interface ApplicationContext {
  companyName: string;
  jobTitle: string;
  status: string;
  round: string;
  interviewKind: string;
  interviewer: string;
  lastNote: string;
}

/**
 * 投递上下文装配。从 `AiScenarioPanel` 的 D15 分支原样搬出（D15 行为等价）：
 * 同一个 db + app 进来，七个字段与旧实现一字不差。
 */
export function buildApplicationContext(db: DB, app: Application): ApplicationContext {
  const interviews = db.interviews
    .filter((item) => item.applicationId === app.id)
    .sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : a.scheduledAt > b.scheduledAt ? -1 : 0));
  const latest = interviews[0];
  const lastNote = db.notes
    .filter((item) => item.applicationId === app.id)
    .sort((a, b) => (a.touchedAt < b.touchedAt ? 1 : a.touchedAt > b.touchedAt ? -1 : 0))[0];
  return {
    companyName: companyFullName(db.companies, app.companyId),
    jobTitle: app.jobTitle,
    status: STATUS_LABEL[app.status],
    round: latest ? `第 ${latest.round} 轮` : '',
    interviewKind: latest?.kind ? INTERVIEW_KIND_LABEL[latest.kind] : '',
    interviewer: latest?.interviewer ?? '',
    lastNote: (lastNote?.content ?? '').slice(0, 200),
  };
}

/** 一个条目的可发送文本：文本字段 `key: value`，bullets 逐行，tags 逗号串 */
function itemText(item: { fields: Record<string, string>; bullets?: string[] }, keys: readonly string[]): string[] {
  const lines: string[] = [];
  for (const rawKey of keys) {
    const meta = FIELD_META[rawKey as FieldKey];
    if (!meta || meta.type === 'image' || meta.type === 'month') continue;
    const value = (item.fields[rawKey] ?? '').trim();
    if (value) lines.push(`${rawKey}: ${value}`);
  }
  for (const bullet of item.bullets ?? []) {
    const trimmed = bullet.trim();
    if (trimmed) lines.push(`description: ${trimmed}`);
  }
  return lines;
}

/**
 * 简历 → 模块列表（不含 basics —— 联系方式的结构性边界见文件头）。
 * 每个模块带 `fieldPaths`（fieldKey → 全路径），JD 定向模型的 fieldPath 落点全靠它；
 * 模型给一个没见过的键，就映射不到任何落点，写回时自然落空（绝不猜）。
 */
export function resumeModules(resume: Pick<Resume, 'templateId' | 'content'>): AiResumeModule[] {
  const modules: AiResumeModule[] = [];
  for (const spec of sectionsOf(resume.templateId)) {
    if (spec.type === 'basics') continue; // ★ 联系方式不出境：结构上就不给这个模块
    const section = resume.content.sections.find((item) => item.type === spec.type);
    if (!section || section.items.length === 0) continue;
    const keys = spec.fields.map((field) => field.key);
    const lines: string[] = [];
    const fieldPaths: Record<string, string> = {};
    let primaryPath: string | null = null;
    let primaryText = '';
    for (const item of section.items) {
      for (const line of itemText(item, keys)) {
        lines.push(line);
        const key = line.slice(0, line.indexOf(':')) as FieldKey;
        if (key && !fieldPaths[key]) {
          fieldPaths[key] = `s:${section.id}:i:${item.id}:${key}`;
        }
      }
      if (!primaryPath) {
        for (const key of PRIMARY_KEYS) {
          if (!keys.includes(key)) continue;
          const value = key === 'description' || key === 'customText' || key === 'skillsText'
            ? (item.bullets ?? []).join('\n').trim()
            : (item.fields[key] ?? '').trim();
          if (value) {
            primaryPath = `s:${section.id}:i:${item.id}:${key}`;
            primaryText = value;
            break;
          }
        }
      }
    }
    if (lines.length === 0) continue;
    modules.push({
      id: section.id,
      label: section.title ?? spec.label ?? spec.type,
      text: lines.join('\n').slice(0, MODULE_CHARS),
      primaryPath,
      primaryText,
      fieldPaths,
    });
  }
  return modules;
}

/** 选中模块 → 发送的合成文本（诊断 / JD 定向共用；`ResumeContent` 只在这里展开成文本） */
export function modulesText(modules: AiResumeModule[]): string {
  return modules.map((module) => `【${module.label}】\n${module.text}`).join('\n\n');
}

/** 兼容导出：T02 时代 planned 的名字（`resumeModulesText`），别处若引用不惊动 */
export const resumeModulesText = modulesText;
