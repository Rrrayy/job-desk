/**
 * 模板登记处（三元组的第一元：schema）。
 *
 * v0.9 的 8 套模板是**代码常量、不入库**（库里只存用户选了哪个 `templateId`），
 * 每套 = 一个 40 行左右的 delta（字段文案全部引用 `base.ts` 的 FIELD_META）。
 *
 * `sectionsOf` 对没登记的 id **回落到 BASE_SECTIONS**：切模板时绝不会因为
 * 某个 id 还没写就渲染成一张空白表单（那是数据丢失级的事故，不是降级）。
 *
 * ★ 8 套没有 lazy / 没有按需 `import()`：一次全在内存里（约 10 KB）。
 * 动态 import 在这里是负收益 —— 它会引入 chunk、chunk 在单文件产物里
 * 又会变成内联的动态脚本，比直接内联常量更贵，还会让「切模板」变成异步失败点。
 */

import type { Template, TemplateId, TemplateSectionSpec } from '../../types';
import { BASE_SECTIONS } from './base';
import { academic } from './academic';
import { campusGeneral } from './campus-general';
import { creative } from './creative';
import { minimalBw } from './minimal-bw';
import { productOps } from './product-ops';
import { socialSimple } from './social-simple';
import { techDouble } from './tech-double';
import { techSingle } from './tech-single';

/**
 * 展示顺序（P0 四套在前，P1 四套在后）。
 *
 * 用数组而不是 `Object.keys(TEMPLATES)`：模板卡片的排列顺序是**产品决策**
 * （先把主力场景摆出来），不该随对象字面量的书写顺序漂移；
 * 参数化测试也用它，保证「测了哪 8 套」与「选了哪 8 套」是同一份清单。
 */
export const TEMPLATE_ORDER: TemplateId[] = [
  'tech-single',
  'campus-general',
  'social-simple',
  'minimal-bw',
  'tech-double',
  'product-ops',
  'academic',
  'creative',
];

/** 8 套模板本体（键必须与 `TemplateId` 一致，`templates.test.ts` 断言两者集合相等） */
export const TEMPLATES: Record<TemplateId, Template> = {
  'tech-single': techSingle,
  'campus-general': campusGeneral,
  'social-simple': socialSimple,
  'minimal-bw': minimalBw,
  'tech-double': techDouble,
  'product-ops': productOps,
  academic,
  creative,
};

/** 按展示顺序拿模板（TemplatePicker 用；8 套齐全，不需要 `undefined` 兜底） */
export const TEMPLATE_LIST: Template[] = TEMPLATE_ORDER.map((id) => TEMPLATES[id]);

/**
 * 取一套模板的板块定义；没登记 → 基座。
 *
 * `TEMPLATES` 的类型是 `Record<TemplateId, Template>`（少登记一套 = 编译不过），
 * 但**运行时**仍可能拿到库里存着的未知 id（老数据 / 手改的导入文件），
 * 所以这里的回退不是死代码，而是把「坏数据」降级成「基座表单」而不是白屏。
 */
export function sectionsOf(templateId: TemplateId): TemplateSectionSpec[] {
  const registry = TEMPLATES as Partial<Record<TemplateId, Template>>;
  return registry[templateId]?.schema.sections ?? BASE_SECTIONS;
}

/** 取模板元数据（名称 / 布局 / 缩略图）；没登记 → undefined（UI 显示「未登记」而不是瞎猜） */
export function templateOf(templateId: TemplateId): Template | undefined {
  return (TEMPLATES as Partial<Record<TemplateId, Template>>)[templateId];
}
