/**
 * 模板的**共享字段基座**（ARCH A-04 / §1.3）。
 *
 * 为什么全仓只留这一份：中文在产物里按 3 B/字计费，34 个字段的
 * label + placeholder + hint ≈ 4.6 KB，复制 8 份就是 37 KB —— 这是 v0.9 唯一
 * 真正大的减法杠杆。8 套模板只写 delta（选哪些字段、哪些必填、要不要覆写文案）。
 *
 * ★ 硬约束（T04 的 delta 必须遵守，`schema.test.ts` 里有断言）：
 * delta **只允许**引用这里的 key，只允许覆写 `required / label / placeholder / hint / type`，
 * **不允许**定义新 key。新 key = 切模板时那段内容无处安放 = 用户数据丢失。
 * 所以「切模板不丢」不是靠人记得，而是靠「字段只有这一份」这个构造事实。
 */

import type {
  ResumeFieldType,
  ResumeSectionType,
  TemplateFieldSpec,
  TemplateSectionSpec,
} from '../../types';

/** 板块的缺省标题（用户改过就用用户的，没改就用这个） */
export const SECTION_LABEL: Record<ResumeSectionType, string> = {
  basics: '基本信息',
  education: '教育经历',
  experience: '实习/工作经历',
  project: '项目经历',
  skills: '专业技能',
  campus: '校园经历',
  awards: '奖项荣誉',
  papers: '论文/课题',
  courses: '主修课程',
  custom: '自定义板块',
};

/** 一个字段的基座元数据：label / 类型 / 示例 / 写法提示 */
export interface FieldMeta {
  label: string;
  type: ResumeFieldType;
  placeholder?: string;
  hint?: string;
}

/**
 * 字段基座。key 就是 `ResumeItem.fields` 的键名（也出现在 AI 润色的 fieldPath 里），
 * **一经发布不许改名** —— 改名等于让所有存量草稿的那一段内容失联。
 */
export const FIELD_META = {
  /* ---- basics ---- */
  name: { label: '姓名', type: 'text', placeholder: '例：张三' },
  phone: { label: '电话', type: 'text', placeholder: '例：138 0000 0000' },
  email: { label: '邮箱', type: 'text', placeholder: '例：zhangsan@example.com' },
  city: { label: '城市', type: 'text', placeholder: '例：北京' },
  photo: { label: '照片', type: 'image', hint: '正方形、浅色背景的证件照效果最好' },

  /* ---- education ---- */
  school: { label: '学校', type: 'text', placeholder: '例：北京邮电大学' },
  major: { label: '专业', type: 'text', placeholder: '例：计算机科学与技术' },
  degree: { label: '学历', type: 'text', placeholder: '例：本科 / 硕士' },
  startMonth: { label: '开始', type: 'month', placeholder: '2022-09' },
  endMonth: { label: '结束', type: 'month', placeholder: '2026-06（在读可留空）' },
  gpa: { label: '绩点/排名', type: 'text', placeholder: '例：3.8/4.0 或 5%' },

  /* ---- experience / project ---- */
  org: { label: '公司/组织', type: 'text', placeholder: '例：字节跳动 · 抖音电商' },
  role: { label: '岗位/角色', type: 'text', placeholder: '例：前端开发实习生' },
  description: {
    label: '职责与成果',
    type: 'rich_bullets',
    placeholder: '一条一个要点',
    hint: '每条一个要点，动词开头，尽量带数字（例：把首屏 FCP 从 1.8s 压到 0.9s）',
  },
  techStack: { label: '用到的技术', type: 'tags', placeholder: 'React, TypeScript, Vite' },
  projectName: { label: '项目名', type: 'text', placeholder: '例：单文件简历工作台' },
  link: { label: '链接', type: 'text', placeholder: '例：github.com/you/repo' },

  /* ---- skills / awards / papers / courses ---- */
  skillsText: {
    label: '专业技能',
    type: 'rich_bullets',
    placeholder: '一行一类技能',
    hint: '例：「熟练：TypeScript / React，了解：Rust 基础语法」',
  },
  awardName: { label: '奖项', type: 'text', placeholder: '例：蓝桥杯省一' },
  awardAt: { label: '获得时间', type: 'month', placeholder: '2024-05' },
  paperTitle: { label: '论文/课题', type: 'text', placeholder: '例：基于 XXX 的 YYY 研究' },
  paperWhere: { label: '期刊/会议', type: 'text', placeholder: '例：某学报 2025 年第 3 期' },
  coursesText: { label: '主修课程', type: 'tags', placeholder: '数据结构, 操作系统, 计算机网络' },

  /* ---- custom ---- */
  customTitle: { label: '小标题', type: 'text', placeholder: '例：开源贡献' },
  customText: { label: '内容', type: 'rich_bullets', placeholder: '一条一个要点' },
} as const satisfies Record<string, FieldMeta>;

export type FieldKey = keyof typeof FIELD_META;

/** 全仓所有字段 key 的清单（T04 的 delta 用它做类型级/测试级校验） */
export const FIELD_KEYS = Object.keys(FIELD_META) as FieldKey[];

/** 字段声明解析后的完整元数据（delta 覆写已合并） */
export interface ResolvedFieldMeta {
  key: string;
  label: string;
  type: ResumeFieldType;
  placeholder?: string;
  hint?: string;
  required: boolean;
}

/**
 * delta 的字段声明 + 基座元数据 → 渲染需要的完整元数据。
 *
 * 覆写优先级：delta > 基座 > 兜底（label 落到 key、type 落到 text）。
 * 兜底不是为了「能跑」：模板写了一个基座里没有的 key 时，用户至少看得见
 * 那个字段的键名，而不是整块表单静默少一行（可发现 > 静默）。
 */
export function fieldMetaOf(spec: TemplateFieldSpec): ResolvedFieldMeta {
  const base = (FIELD_META as Record<string, FieldMeta | undefined>)[spec.key];
  return {
    key: spec.key,
    label: spec.label ?? base?.label ?? spec.key,
    type: spec.type ?? base?.type ?? 'text',
    placeholder: spec.placeholder ?? base?.placeholder,
    hint: spec.hint ?? base?.hint,
    required: spec.required ?? false,
  };
}

/**
 * 基座 schema：**任何模板都覆盖不到的兜底**，也是 T04 落地前唯一可用的表单。
 *
 * 它同时是「最小可用简历」：基本信息 + 教育 + 经历 + 项目 + 技能 + 奖项。
 * T04 的 8 套 delta 是在它之上的取舍，不是另起一套 —— `sectionsOf` 找不到模板时
 * 回落到这里（切模板时绝不会因为模板没登记就渲染成空白表单）。
 */
export const BASE_SECTIONS: TemplateSectionSpec[] = [
  {
    type: 'basics',
    repeatable: false,
    fields: [
      { key: 'name', required: true },
      { key: 'phone', required: true },
      { key: 'email', required: true },
      { key: 'city' },
    ],
  },
  {
    type: 'education',
    repeatable: true,
    fields: [
      { key: 'school', required: true },
      { key: 'major' },
      { key: 'degree' },
      { key: 'startMonth' },
      { key: 'endMonth' },
      { key: 'gpa' },
    ],
  },
  {
    type: 'experience',
    repeatable: true,
    fields: [
      { key: 'org', required: true },
      { key: 'role' },
      { key: 'startMonth' },
      { key: 'endMonth' },
      { key: 'description' },
      { key: 'techStack' },
    ],
  },
  {
    type: 'project',
    repeatable: true,
    fields: [
      { key: 'projectName', required: true },
      { key: 'role' },
      { key: 'startMonth' },
      { key: 'endMonth' },
      { key: 'description' },
      { key: 'techStack' },
      { key: 'link' },
    ],
  },
  { type: 'skills', repeatable: false, fields: [{ key: 'skillsText' }] },
  { type: 'awards', repeatable: true, fields: [{ key: 'awardName' }, { key: 'awardAt' }] },
];
