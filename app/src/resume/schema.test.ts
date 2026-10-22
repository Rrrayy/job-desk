/**
 * `resume/schema.ts` 的纯函数回归。
 *
 * 这一层的每一条断言都在守一件用户资产的完整性，而不是「函数返回了对的东西」：
 * - `parseTags` / `formatTags` 往返：用户手打的技能串不能因为一个中文逗号被拆坏；
 * - `ensureSectionsWith` 只补缺：**切模板 = 只改 templateId**，content 一条都不能少（铁律 6）；
 * - `setXxx` 全返回新对象且原对象不变：视图靠引用相等判断要不要重渲，
 *   半深半浅的更新会变成「改了没保存」或「保存了没刷新」。
 */

import { describe, expect, it } from 'vitest';
import type { ResumeContent, TemplateId, TemplateSectionSpec } from '../types';
import {
  addItem,
  cleanBullets,
  emptyContentOf,
  ensureSections,
  ensureSectionsWith,
  fieldValueOf,
  formatTags,
  itemOf,
  moveItem,
  parseTags,
  removeItem,
  sectionOf,
  setBullets,
  setField,
  setSectionTitle,
} from './schema';
import {
  BASE_SECTIONS,
  FIELD_KEYS,
  FIELD_META,
  SECTION_LABEL,
  fieldMetaOf,
} from './templates/base';
import { TEMPLATES, TEMPLATE_ORDER, sectionsOf } from './templates';

/* ------------------------------ 标签 ------------------------------ */

describe('parseTags / formatTags：逗号串 ⇄ 数组', () => {
  it('半角逗号、中文逗号、分号、换行都算分隔符', () => {
    expect(parseTags('React, TypeScript，Vite；Rust\nGo')).toEqual([
      'React',
      'TypeScript',
      'Vite',
      'Rust',
      'Go',
    ]);
  });

  it('去重保序，空片段丢掉（用户多打几个逗号不该出现空标签）', () => {
    expect(parseTags(' React ,, react ,  , Vue , React ')).toEqual(['React', 'react', 'Vue']);
  });

  it('空值 / undefined / 全是分隔符 → 空数组', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags(' , ，; ')).toEqual([]);
  });

  it('★ 往返：formatTags(parseTags(x)) 幂等，且规范化成「逗号 + 单空格」', () => {
    const raw = 'React,TypeScript，  Vite,,React';
    const once = formatTags(raw);
    expect(once).toBe('React, TypeScript, Vite');
    expect(formatTags(once)).toBe(once);
  });

  it('formatTags 也接数组（AI 写回手里是数组，不该逼调用方先 join）', () => {
    expect(formatTags([' React ', 'Vue', 'React'])).toBe('React, Vue');
    expect(formatTags([])).toBe('');
  });
});

/* ------------------------------ 要点 ------------------------------ */

describe('cleanBullets：空行不落库（在读的一侧滤）', () => {
  it('滤掉空白行与纯空格行，保留顺序，两端 trim', () => {
    expect(cleanBullets(['  把 FCP 压到 0.9s ', '', '   ', '带 3 人小组上线'])).toEqual([
      '把 FCP 压到 0.9s',
      '带 3 人小组上线',
    ]);
  });

  it('undefined / 空数组 → 空数组（调用方不必先判空）', () => {
    expect(cleanBullets(undefined)).toEqual([]);
    expect(cleanBullets([])).toEqual([]);
  });
});

/* ------------------------------ 基座与字段元数据 ------------------------------ */

describe('字段基座（FIELD_META）', () => {
  it('★ 基座 schema 只引用基座里已有的字段 key（T04 的 delta 也必须守这条）', () => {
    for (const section of BASE_SECTIONS) {
      expect(section.fields.length).toBeGreaterThan(0);
      for (const field of section.fields) {
        expect(FIELD_KEYS).toContain(field.key);
      }
    }
  });

  it('板块标题表覆盖 10 种板块类型', () => {
    expect(Object.keys(SECTION_LABEL)).toHaveLength(10);
    expect(SECTION_LABEL.basics).toBe('基本信息');
  });

  it('fieldMetaOf：delta 能覆写 label / placeholder / required，没覆写的取基座', () => {
    const meta = fieldMetaOf({ key: 'school', label: '毕业院校', required: true });
    expect(meta.label).toBe('毕业院校');
    expect(meta.placeholder).toBe(FIELD_META.school.placeholder);
    expect(meta.type).toBe('text');
    expect(meta.required).toBe(true);
  });

  it('fieldMetaOf：未知 key 不崩，label 退到 key 本身（可发现 > 静默少一行）', () => {
    const meta = fieldMetaOf({ key: 'mystery' });
    expect(meta.label).toBe('mystery');
    expect(meta.type).toBe('text');
    expect(meta.required).toBe(false);
  });

  it('delta 可以改字段类型（例如把 description 当 text 用）', () => {
    expect(fieldMetaOf({ key: 'description', type: 'text' }).type).toBe('text');
  });
});

/* ------------------------------ 补板块 ------------------------------ */

const SCHEMA_A: TemplateSectionSpec[] = [
  { type: 'basics', repeatable: false, fields: [{ key: 'name' }, { key: 'email' }] },
  {
    type: 'project',
    repeatable: true,
    fields: [{ key: 'projectName' }, { key: 'description' }, { key: 'techStack' }],
  },
];

const SCHEMA_B: TemplateSectionSpec[] = [
  { type: 'basics', repeatable: false, fields: [{ key: 'name' }, { key: 'city' }] },
  {
    type: 'campus',
    repeatable: true,
    fields: [{ key: 'org' }, { key: 'role' }, { key: 'description' }],
  },
  { type: 'awards', repeatable: true, fields: [{ key: 'awardName' }] },
];

describe('ensureSectionsWith：只补缺、不清洗、幂等', () => {
  it('缺的板块补到末尾，每个板块至少一个条目', () => {
    const content = ensureSectionsWith({ sections: [] }, SCHEMA_A);
    expect(content.sections.map((s) => s.type)).toEqual(['basics', 'project']);
    for (const section of content.sections) expect(section.items).toHaveLength(1);
  });

  it('★ 幂等：第二次调用返回同一个引用（JSON 逐字节相等）', () => {
    const once = ensureSectionsWith({ sections: [] }, SCHEMA_A);
    const twice = ensureSectionsWith(once, SCHEMA_A);
    expect(twice).toBe(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('★ 不清理：模板里没有的板块原样保留（数据是超集）', () => {
    const content = ensureSectionsWith({ sections: [] }, SCHEMA_B);
    const back = ensureSectionsWith(content, SCHEMA_A);
    expect(back.sections.map((s) => s.type)).toEqual(['basics', 'campus', 'awards', 'project']);
  });

  it('已存在的板块不被重排、不被重建（条目 id 不变）', () => {
    const content = ensureSectionsWith({ sections: [] }, SCHEMA_A);
    const firstItemId = content.sections[1].items[0].id;
    const next = ensureSectionsWith(content, SCHEMA_A);
    expect(sectionOf(next, content.sections[1].id)?.items[0].id).toBe(firstItemId);
  });

  it('★ 切模板绝不渲染空表单：未登记 → 回落基座；已登记 → 用模板自己的 delta', () => {
    // 未登记（历史草稿里的旧 id、手改过的 id）：必须整体回落到基座 —— 回落成空表单等于数据丢失
    const unknown = 'tpl-from-the-future' as TemplateId;
    expect(sectionsOf(unknown)).toBe(BASE_SECTIONS);
    const fallback = ensureSections({ sections: [] }, unknown);
    expect(fallback.sections.map((s) => s.type)).toEqual(BASE_SECTIONS.map((s) => s.type));
    for (const section of fallback.sections) expect(section.items).toHaveLength(1);

    // 已登记：字段表来自模板 delta（不是基座），且顺序即渲染顺序
    for (const templateId of TEMPLATE_ORDER) {
      const sections = sectionsOf(templateId);
      expect(sections).toBe(TEMPLATES[templateId].schema.sections);
      const content = ensureSections({ sections: [] }, templateId);
      expect(content.sections.map((s) => s.type)).toEqual(sections.map((s) => s.type));
    }
  });

  it('emptyContentOf：板块齐全、字段都是空的', () => {
    const content = emptyContentOf('minimal-bw');
    expect(content.sections).toHaveLength(BASE_SECTIONS.length);
    for (const section of content.sections) {
      expect(section.items).toHaveLength(1);
      expect(section.items[0].fields).toEqual({});
    }
  });
});

/* ------------------------------ 验收 4 的数据侧 ------------------------------ */

/** 把一份内容的所有字段填上可区分真假的值（模拟「填了 30 个字段」） */
function fillAll(content: ResumeContent, specs: TemplateSectionSpec[]): ResumeContent {
  let next = content;
  for (const spec of specs) {
    const section = next.sections.find((item) => item.type === spec.type);
    if (!section) continue;
    for (const item of section.items) {
      for (const field of spec.fields) {
        next = setField(next, section.id, item.id, field.key, `${spec.type}/${field.key} 的值`);
      }
    }
  }
  return next;
}

describe('★ 验收 4 的数据侧：两套 schema 互切，字段零丢失', () => {
  it('A → B → A：A 的每个字段值逐字段相等（含 B 里没有的字段）', () => {
    // 先在 A 上填满 → 切到 B（B 的板块被补出来）→ 在 B 上填满 → 切回 A
    let content = fillAll(ensureSectionsWith({ sections: [] }, SCHEMA_A), SCHEMA_A);
    content = fillAll(ensureSectionsWith(content, SCHEMA_B), SCHEMA_B);
    content = ensureSectionsWith(content, SCHEMA_A);

    for (const spec of SCHEMA_A) {
      const section = content.sections.find((item) => item.type === spec.type);
      expect(section).toBeDefined();
      for (const field of spec.fields) {
        for (const item of section?.items ?? []) {
          expect(fieldValueOf(item, field.key)).toBe(`${spec.type}/${field.key} 的值`);
        }
      }
    }
    // B 独有的字段也在（切走再切回不会把别人的内容删掉）
    const campus = content.sections.find((item) => item.type === 'campus');
    expect(fieldValueOf(itemOf(campus, campus?.items[0].id ?? ''), 'org')).toBe('campus/org 的值');
  });

  it('切 4 次（8 套真实模板 id 轮一遍）后，基座字段仍然逐字段相等', () => {
    const specs = sectionsOf('tech-single');
    const filled = fillAll(ensureSectionsWith({ sections: [] }, specs), specs);
    let content = filled;
    for (const id of ['tech-double', 'product-ops', 'campus-general', 'creative'] as const) {
      content = ensureSections(content, id);
    }
    content = ensureSections(content, 'tech-single');

    for (const spec of specs) {
      const section = content.sections.find((item) => item.type === spec.type);
      for (const field of spec.fields) {
        expect(fieldValueOf(section?.items[0], field.key)).toBe(`${spec.type}/${field.key} 的值`);
      }
    }
  });
});

/* ------------------------------ 不可变修改 ------------------------------ */

describe('不可变修改：返回新对象，原对象一字不改', () => {
  const base = ensureSectionsWith({ sections: [] }, SCHEMA_A);
  const sectionId = base.sections[1].id;
  const itemId = base.sections[1].items[0].id;

  it('setField 写进新对象，旧对象仍是空值', () => {
    const next = setField(base, sectionId, itemId, 'projectName', '单文件简历工作台');
    expect(fieldValueOf(itemOf(sectionOf(next, sectionId), itemId), 'projectName')).toBe(
      '单文件简历工作台',
    );
    expect(sectionOf(base, sectionId)?.items[0].fields).toEqual({});
    expect(next).not.toBe(base);
  });

  it('没命中 sectionId / itemId 时返回同一个引用（不会白重渲）', () => {
    expect(setField(base, 'nope', itemId, 'projectName', 'x')).toBe(base);
    expect(setField(base, sectionId, 'nope', 'projectName', 'x')).toBe(base);
    expect(setBullets(base, 'nope', itemId, ['x'])).toBe(base);
    expect(setSectionTitle(base, 'nope', '标题')).toBe(base);
    expect(removeItem(base, sectionId, 'nope')).toBe(base);
    expect(moveItem(base, sectionId, 'nope', 1)).toBe(base);
  });

  it('setBullets：写数组；空数组时删掉 bullets 键（导出更干净）', () => {
    const withBullets = setBullets(base, sectionId, itemId, ['一', '二']);
    expect(itemOf(sectionOf(withBullets, sectionId), itemId)?.bullets).toEqual(['一', '二']);
    const cleared = setBullets(withBullets, sectionId, itemId, []);
    expect(itemOf(sectionOf(cleared, sectionId), itemId)).not.toHaveProperty('bullets');
  });

  it('setSectionTitle：有值写 title，空白值把 title 删掉（回落到模板板块名）', () => {
    const named = setSectionTitle(base, sectionId, '  项目 / 作品  ');
    expect(sectionOf(named, sectionId)?.title).toBe('  项目 / 作品  ');
    const cleared = setSectionTitle(named, sectionId, '   ');
    expect(sectionOf(cleared, sectionId)).not.toHaveProperty('title');
  });
});

describe('条目增删移序（PRD 验收 5 的条目侧）', () => {
  const base = ensureSectionsWith({ sections: [] }, SCHEMA_A);
  const sectionId = base.sections[1].id;

  it('加一条 → 变 2 条；删掉中间那条 → 剩 1 条', () => {
    const two = addItem(base, sectionId);
    expect(sectionOf(two, sectionId)?.items).toHaveLength(2);
    const one = removeItem(two, sectionId, sectionOf(two, sectionId)?.items[0].id ?? '');
    expect(sectionOf(one, sectionId)?.items).toHaveLength(1);
  });

  it('★ 上移 / 下移改的是顺序，不是内容', () => {
    // 必须从 base 派生：ensureSectionsWith 每次都生成新的 section id，
    // 另起一份内容再拿 base 的 id 去找是找不到的（这条断言自己踩过这个坑）
    let content = addItem(base, sectionId);
    content = addItem(content, sectionId);
    const ids = sectionOf(content, sectionId)?.items.map((item) => item.id) ?? [];
    expect(ids).toHaveLength(3);

    // 第三个上移一位 → 顺序变成 1,3,2
    const movedUp = moveItem(content, sectionId, ids[2], -1);
    expect(sectionOf(movedUp, sectionId)?.items.map((item) => item.id)).toEqual([
      ids[0],
      ids[2],
      ids[1],
    ]);
    // 第一个再下移一位 → 回到 3,1,2
    const movedDown = moveItem(movedUp, sectionId, ids[0], 1);
    expect(sectionOf(movedDown, sectionId)?.items.map((item) => item.id)).toEqual([
      ids[2],
      ids[0],
      ids[1],
    ]);
  });

  it('到顶 / 到底时原样返回同一个引用（按钮点不动就是点不动）', () => {
    const ids = sectionOf(base, sectionId)?.items.map((item) => item.id) ?? [];
    expect(moveItem(base, sectionId, ids[0], -1)).toBe(base);
    expect(moveItem(base, sectionId, ids[ids.length - 1], 1)).toBe(base);
  });

  it('删到一个不剩也不报错（板块变成只剩「+ 加一条」）', () => {
    const empty = removeItem(base, sectionId, sectionOf(base, sectionId)?.items[0].id ?? '');
    expect(sectionOf(empty, sectionId)?.items).toEqual([]);
    const restored = addItem(empty, sectionId);
    expect(sectionOf(restored, sectionId)?.items).toHaveLength(1);
  });
});
