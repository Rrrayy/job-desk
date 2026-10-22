/**
 * 简历内容的**纯函数层**（零 React、零 DOM、零 localStorage）。
 *
 * 这一层的职责只有两件：
 * 1. 把 `ResumeContent` 当成不可变数据来改（每个 set/move/remove 都返回新对象，
 *    没命中目标时返回**同一个引用** —— 视图因此不会无谓重渲）；
 * 2. 让「数据是超集、模板只是视图」这条铁律有唯一的落地点：`ensureSections` 只补缺、
 *    不清理，所以切模板永远不会删掉任何一个字段值。
 *
 * 为什么 UI 不自己写 map/spread：AI 写回（T07）、版本快照（T05）、表单（T02）三处
 * 都要「按 sectionId + itemId + key 改一个值」，各写一遍必然有一处忘了保持不可变，
 * 那处就会变成「改了没保存」或「保存了没刷新」。
 */

import type {
  ResumeContent,
  ResumeItem,
  ResumeSection,
  TemplateId,
  TemplateSectionSpec,
} from '../types';
import { uid } from '../lib/util';
import { sectionsOf } from './templates';

/* ------------------------------ 标签（tags） ------------------------------ */

/**
 * 逗号串 → 标签数组。
 * 分隔符收中文逗号 / 分号 / 换行：用户从别处粘一串技能时这几种混着出现，
 * 只认半角逗号会得到「React；Vue」这样一个标签。
 */
export function parseTags(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,，;；\n]/)) {
    const tag = part.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * 标签 → 逗号串（存回 `ResumeItem.fields[key]`）。
 * 入参兼容数组：AI 写回时手里是数组，不该逼调用方先 join 一遍。
 */
export function formatTags(raw: string | readonly string[] | undefined | null): string {
  const list = typeof raw === 'string' ? parseTags(raw) : (raw ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const tag = item.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out.join(', ');
}

/* ------------------------------ 要点（rich_bullets） ------------------------------ */

/**
 * 要点清理：**空行不落库**（ARCH §1.6）。
 *
 * 注意「草稿 vs 落库」的区别：表单里允许存在一行刚点「+ 加一条」的空行
 * （否则那一行根本没法输入），但**快照 / 预览 / AI 导出**都必须先过这里。
 * 所以清理发生在「读」的一侧，而不是在 onChange 里 —— 在 onChange 里滤掉空行，
 * 会让用户点「加一条」后那一行立刻消失。
 */
export function cleanBullets(bullets: readonly string[] | undefined): string[] {
  if (!bullets) return [];
  return bullets.map((line) => line.trim()).filter((line) => line !== '');
}

/* ------------------------------ 构造 ------------------------------ */

export function emptyItem(): ResumeItem {
  return { id: uid('ritem'), fields: {} };
}

export function emptySectionOf(spec: TemplateSectionSpec): ResumeSection {
  // 即使 repeatable=false 也要一个 item：非重复板块（基本信息 / 技能）也得有地方存字段
  return { id: uid('rsec'), type: spec.type, items: [emptyItem()] };
}

/**
 * 按模板补齐缺失的板块（**只补缺，不清理，不重排**）。
 *
 * - 已存在的板块一律不动（用户改过的标题、条目顺序、字段值全部保留）；
 * - 没有的板块追加到末尾（新内容的落点是「后面」，不改动用户已经排好的顺序）；
 * - 什么都不缺时返回**同一个引用** → 幂等（连续调用两次 JSON 完全相等）。
 *
 * 不做的事（故意的）：不删模板里没有的板块、不删空条目、不重命名标题。
 * 那些都是用户数据；「切模板」只应该改 `templateId`（铁律 6）。
 */
export function ensureSectionsWith(
  content: ResumeContent,
  specs: readonly TemplateSectionSpec[],
): ResumeContent {
  const existing = new Set(content.sections.map((section) => section.type));
  const missing = specs.filter((spec) => !existing.has(spec.type)).map(emptySectionOf);
  if (missing.length === 0) return content;
  return { ...content, sections: [...content.sections, ...missing] };
}

/** 按模板 id 补板块（sectionsOf 找不到模板时回落到基座，不会渲染空白表单） */
export function ensureSections(content: ResumeContent, templateId: TemplateId): ResumeContent {
  return ensureSectionsWith(content, sectionsOf(templateId));
}

/** 一份模板对应的空内容（新建简历时用） */
export function emptyContentOf(templateId: TemplateId): ResumeContent {
  return ensureSectionsWith({ sections: [] }, sectionsOf(templateId));
}

/* ------------------------------ 定位 ------------------------------ */

export function sectionOf(content: ResumeContent, sectionId: string): ResumeSection | undefined {
  return content.sections.find((section) => section.id === sectionId);
}

export function itemOf(section: ResumeSection | undefined, itemId: string): ResumeItem | undefined {
  return section?.items.find((item) => item.id === itemId);
}

/** 字段值（没填 = 空串，不是 undefined —— 输入框需要字符串） */
export function fieldValueOf(item: ResumeItem | undefined, key: string): string {
  return item?.fields[key] ?? '';
}

/* ------------------------------ 不可变修改 ------------------------------ */

function replaceSection(
  content: ResumeContent,
  sectionId: string,
  recipe: (section: ResumeSection) => ResumeSection,
): ResumeContent {
  const index = content.sections.findIndex((section) => section.id === sectionId);
  if (index < 0) return content;
  const current = content.sections[index];
  const next = recipe(current);
  // recipe 说「没变」就真的没变：返回同一个引用，视图不会白重渲（也保住幂等语义）
  if (next === current) return content;
  const sections = content.sections.slice();
  sections[index] = next;
  return { ...content, sections };
}

function replaceItem(
  section: ResumeSection,
  itemId: string,
  recipe: (item: ResumeItem) => ResumeItem,
): ResumeSection {
  const index = section.items.findIndex((item) => item.id === itemId);
  if (index < 0) return section;
  const items = section.items.slice();
  items[index] = recipe(section.items[index]);
  return { ...section, items };
}

/** 写一个文本/标签字段（`rich_bullets` 走 setBullets） */
export function setField(
  content: ResumeContent,
  sectionId: string,
  itemId: string,
  key: string,
  value: string,
): ResumeContent {
  return replaceSection(content, sectionId, (section) =>
    replaceItem(section, itemId, (item) => ({ ...item, fields: { ...item.fields, [key]: value } })),
  );
}

/** 写要点数组；空数组时**删掉 `bullets` 键**而不是留一个 `[]`（导出更干净） */
export function setBullets(
  content: ResumeContent,
  sectionId: string,
  itemId: string,
  bullets: readonly string[],
): ResumeContent {
  return replaceSection(content, sectionId, (section) =>
    replaceItem(section, itemId, (item) => {
      const next: ResumeItem = { ...item };
      if (bullets.length > 0) next.bullets = [...bullets];
      else delete next.bullets;
      return next;
    }),
  );
}

/**
 * 改板块名。传空 → **删掉 `title` 键**（回落到模板的板块名）。
 * 不要存空串：空串在导出里是噪音，而「没改过」的语义正好就是 undefined。
 */
export function setSectionTitle(
  content: ResumeContent,
  sectionId: string,
  title: string | undefined,
): ResumeContent {
  return replaceSection(content, sectionId, (section) => {
    const next: ResumeSection = { ...section };
    const trimmed = title?.trim() ?? '';
    if (trimmed) next.title = title as string;
    else delete next.title;
    return next;
  });
}

export function addItem(content: ResumeContent, sectionId: string): ResumeContent {
  return replaceSection(content, sectionId, (section) => ({
    ...section,
    items: [...section.items, emptyItem()],
  }));
}

export function removeItem(content: ResumeContent, sectionId: string, itemId: string): ResumeContent {
  return replaceSection(content, sectionId, (section) => {
    if (!section.items.some((item) => item.id === itemId)) return section;
    return { ...section, items: section.items.filter((item) => item.id !== itemId) };
  });
}

/** 上下移动一个条目；到顶/到底时原样返回（同一个引用，按钮点不动就是点不动） */
export function moveItem(
  content: ResumeContent,
  sectionId: string,
  itemId: string,
  delta: number,
): ResumeContent {
  return replaceSection(content, sectionId, (section) => {
    const from = section.items.findIndex((item) => item.id === itemId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= section.items.length) return section;
    const items = section.items.slice();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    return { ...section, items };
  });
}
