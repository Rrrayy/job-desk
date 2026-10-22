/**
 * 8 套模板的一致性（ARCH §6.3）—— **参数化跑，一条代码覆盖 8 套**。
 *
 * 为什么不用「8 份 HTML 快照」：一份 A4 快照 5–10 KB，8 份让测试文件膨胀到 80 KB，
 * 而 `--update` 会变成盲区（没人会逐字看 8 份 HTML diff）。这里断言的是**不变量**：
 * 结构、key 集合、缩略图字节、切模板往返 —— 这些坏掉一定是真 bug，也不会误报。
 *
 * ★ 往返断言必须是「包含关系」而不是 `toEqual`：`ensureSectionsWith` 是
 *   「只补缺不清洗」（切走会 append 别的模板的板块），切回后 `back` 是 `filled` 的超集。
 *   写成 `expect(back).toEqual(filled)` 必然假失败 —— ARCH §6.3 已按此修正。
 */

import { describe, expect, it } from 'vitest';
import type { ResumeContent, TemplateId } from '../../types';
import { FIELD_META, type FieldKey } from './base';
import { ensureSections, emptyContentOf, setBullets, setField } from '../schema';
import { TEMPLATES, TEMPLATE_ORDER, TEMPLATE_LIST, sectionsOf, templateOf } from './index';
import { BASE_SECTIONS } from './base';

const FIELD_KEYS = Object.keys(FIELD_META) as FieldKey[];
const BREAK_CLASSES = ['.rs-item', '.rs-section', '.rs-section__title'];
const LAYOUTS = ['single', 'double', 'timeline'];

/**
 * 往一份内容里填满 N 个字段（含**模板独有字段**）。
 *
 * 刻意直接遍历 `FIELD_META` 全集而不是遍历模板 schema：
 * 「切模板不丢」要证明的正是「这套模板没有的字段也不许丢」。
 */
function fillAllFields(content: ResumeContent, limit: number): ResumeContent {
  let next = content;
  let count = 0;
  for (const section of content.sections) {
    for (const item of section.items) {
      for (const key of FIELD_KEYS) {
        if (count >= limit) return next;
        const meta = FIELD_META[key];
        if (meta.type === 'rich_bullets') {
          next = setBullets(next, section.id, item.id, [`要点 ${count}`, `要点 ${count}-2`]);
        } else if (meta.type === 'image') {
          next = setField(next, section.id, item.id, key, 'data:image/jpeg;base64,AAAA');
        } else {
          next = setField(next, section.id, item.id, key, `值 ${count}`);
        }
        count += 1;
      }
    }
  }
  return next;
}

describe.each(TEMPLATE_ORDER)('模板 %s', (id) => {
  const template = TEMPLATES[id];

  it('schema 结构不变式：≥4 个板块、板块与字段都不重复、layout 合法', () => {
    expect(template.schema.sections.length).toBeGreaterThanOrEqual(4);
    expect(new Set(template.schema.sections.map((s) => s.type)).size).toBe(template.schema.sections.length);
    for (const section of template.schema.sections) {
      expect(section.fields.length).toBeGreaterThan(0);
      expect(new Set(section.fields.map((f) => f.key)).size).toBe(section.fields.length);
    }
    expect(LAYOUTS).toContain(template.layout);
  });

  it('★ delta 只引用基座字段（新 key = 换模板时丢数据）', () => {
    for (const section of template.schema.sections) {
      for (const field of section.fields) {
        expect(FIELD_KEYS).toContain(field.key);
      }
    }
  });

  it('★ 缩略图：自包含 SVG、无外链、≤1 KB', () => {
    const svg = template.thumbnail;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).not.toMatch(/https?:/);
    expect(svg).toContain('viewBox');
    expect(new TextEncoder().encode(svg).length).toBeLessThanOrEqual(1024);
  });

  it('breakAvoid 声明落在稳定类上（打印规则只许引用 .rs-* 与 .a4*）', () => {
    expect(template.printRules.breakAvoid.length).toBeGreaterThan(0);
    for (const selector of template.printRules.breakAvoid) {
      expect(BREAK_CLASSES).toContain(selector);
    }
    // pageMarginMm 只是元数据：@page 全仓唯一静态（Q4），这里只保证它是个合理值
    expect(template.printRules.pageMarginMm).toBe(14);
  });

  it('★ 填 30 个字段 → 切走 4 套 → 切回 → 每个字段逐个相等（含模板独有字段）', () => {
    const filled = fillAllFields(emptyContentOf(id), 30);

    let content = filled;
    for (const other of TEMPLATE_ORDER.slice(0, 4)) content = ensureSections(content, other);
    const back = ensureSections(content, id);

    // 切走再切回不许新增板块（既有板块一律不动）
    for (const section of filled.sections) {
      const after = back.sections.find((item) => item.id === section.id);
      expect(after).toBeDefined();
      expect(after!.type).toBe(section.type);
      for (const item of section.items) {
        const afterItem = after!.items.find((entry) => entry.id === item.id);
        expect(afterItem).toBeDefined();
        // 逐字段包含断言（不要整体 toEqual：back 是超集）
        for (const [key, value] of Object.entries(item.fields)) {
          expect(afterItem!.fields[key]).toBe(value);
        }
        expect(afterItem!.bullets).toEqual(item.bullets);
      }
    }
  });
});

describe('8 套模板的跨模板一致性', () => {
  it('登记处完整：TEMPLATE_ORDER / TEMPLATES / TemplateId 三者是同一份 8 个 id', () => {
    expect(TEMPLATE_ORDER).toHaveLength(8);
    expect(new Set(TEMPLATE_ORDER).size).toBe(8);
    expect(Object.keys(TEMPLATES).sort()).toEqual([...TEMPLATE_ORDER].sort());
    for (const id of TEMPLATE_ORDER) {
      expect(TEMPLATES[id].id).toBe(id);
      expect(TEMPLATES[id].name.length).toBeGreaterThan(0);
      expect(TEMPLATES[id].targetDirection.length).toBeGreaterThan(0);
    }
    expect(TEMPLATE_LIST.map((t) => t.id)).toEqual(TEMPLATE_ORDER);
    // 名称不许重名（模板选择器上一模一样的两个名字等于让用户瞎选）
    expect(new Set(TEMPLATE_LIST.map((t) => t.name)).size).toBe(8);
  });

  it('★ 全部字段 key ⊆ 基座；photo 只由 creative 提供', () => {
    const used = new Set<string>();
    const withPhoto: TemplateId[] = [];
    for (const id of TEMPLATE_ORDER) {
      const keys = TEMPLATES[id].schema.sections.flatMap((section) => section.fields.map((f) => f.key));
      for (const key of keys) {
        expect(FIELD_KEYS).toContain(key);
        used.add(key);
      }
      if (keys.includes('photo')) withPhoto.push(id);
    }
    // 8 套合起来必须把基座里的字段用得差不多（否则 FIELD_META 里就是死重量）
    expect(used.size).toBeGreaterThanOrEqual(FIELD_KEYS.length - 6);
    expect(withPhoto).toEqual(['creative']);
  });

  it('未登记的 id 回落到基座，而不是渲染空表单', () => {
    const bogus = 'not-a-template' as TemplateId;
    expect(sectionsOf(bogus)).toBe(BASE_SECTIONS);
    expect(templateOf(bogus)).toBeUndefined();
    // 基座本身有板块 → 表单一格都不会空
    expect(BASE_SECTIONS.length).toBeGreaterThan(0);
  });
});
