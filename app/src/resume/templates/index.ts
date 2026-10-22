/**
 * 模板登记处（三元组的第一元：schema）。
 *
 * v0.9 的 8 套模板是**代码常量、不入库**（库里只存用户选了哪个 `templateId`），
 * 每套 = 一个 40 行左右的 delta（见 T04），字段文案全部引用 `base.ts` 的 FIELD_META。
 *
 * T02 只落「基座 + 登记处 + 回退」，8 套 delta 由 T04 在这里登记。
 * `sectionsOf` 对没登记的 id **回落到 BASE_SECTIONS**：切模板时绝不会因为
 * 某个 id 还没写就渲染成一张空白表单（那是数据丢失级的事故，不是降级）。
 */

import type { Template, TemplateId, TemplateSectionSpec } from '../../types';
import { BASE_SECTIONS } from './base';

/** T04 在此登记 8 套（`tech-single` … `creative`），键必须与 TemplateId 一致 */
export const TEMPLATES: Partial<Record<TemplateId, Template>> = {};

/** 取一套模板的板块定义；没登记 → 基座 */
export function sectionsOf(templateId: TemplateId): TemplateSectionSpec[] {
  return TEMPLATES[templateId]?.schema.sections ?? BASE_SECTIONS;
}

/** 取模板元数据（名称 / 布局 / 缩略图）；没登记 → undefined（UI 显示「未登记」而不是瞎猜） */
export function templateOf(templateId: TemplateId): Template | undefined {
  return TEMPLATES[templateId];
}
