// @vitest-environment jsdom
/**
 * SchemaForm（通用表单渲染器）。
 *
 * 这一组测试守的是「schema 驱动」这件事本身：
 * - 换一份 schema 就换一批控件，组件里没有任何 `if (templateId === …)`；
 * - 5 种字段类型都有真实控件（text/month 复用 `<Field>`，其余 3 个是新组件）；
 * - 空表单也能渲染、必填未填只提示不拦截（PRD §8.3）。
 *
 * 表单是**受控**的：它不持有草稿，只把「改成什么样」整份抛回去。
 * 所以测试里挂一个十行的 Harness 当父组件 —— 真实调用方（T05 的 ResumeEditor）
 * 也是这么用的，只是它额外接了防抖通道。
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResumeContent, TemplateSectionSpec } from '../../types';
import { ensureSectionsWith } from '../../resume/schema';
import { SchemaForm } from './SchemaForm';

const SCHEMA: TemplateSectionSpec[] = [
  { type: 'basics', repeatable: false, fields: [{ key: 'name', required: true }, { key: 'email' }] },
  {
    type: 'education',
    repeatable: true,
    fields: [{ key: 'school', required: true }, { key: 'startMonth' }, { key: 'endMonth' }],
  },
  {
    type: 'project',
    repeatable: true,
    fields: [{ key: 'projectName' }, { key: 'description' }, { key: 'techStack' }],
  },
  { type: 'skills', repeatable: false, fields: [{ key: 'skillsText' }] },
];

describe('SchemaForm（jsdom）', () => {
  let container: HTMLDivElement;
  let root: Root;
  /** 父组件收到的最后一次内容（受控组件：组件自己不留底稿） */
  let latest: ResumeContent;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** 十行 Harness：持有草稿 + 把每次改动记下来 */
  function Harness({ sections, content }: { sections: TemplateSectionSpec[]; content: ResumeContent }) {
    const [draft, setDraft] = useState(content);
    return (
      <SchemaForm
        sections={sections}
        content={draft}
        onChange={(next) => {
          latest = next;
          setDraft(next);
        }}
      />
    );
  }

  async function render(sections: TemplateSectionSpec[] = SCHEMA): Promise<void> {
    // ★ 内容与 schema 必须是同一份：传进去的 section 在 content 里不存在就会被跳过
    latest = ensureSectionsWith({ sections: [] }, sections);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness sections={sections} content={latest} />);
    });
  }

  /** 第 index 个板块的 DOM（同一页里有多个 bullets 字段，查询必须收敛到板块内） */
  function block(index: number): HTMLElement {
    return container.querySelectorAll<HTMLElement>('.resume-form__section')[index];
  }

  function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function click(element: Element | null): void {
    expect(element).not.toBeNull();
    act(() => {
      (element as HTMLElement).click();
    });
  }

  function section(type: string) {
    return latest.sections.find((item) => item.type === type)!;
  }

  /* ------------------------------ 渲染 ------------------------------ */

  it('★ 按 schema 渲染全部字段：text 走 input[type=text]，month 走原生 input[type=month]', async () => {
    await render();

    const labels = Array.from(container.querySelectorAll('.field__label')).map((el) => el.textContent);
    expect(labels).toEqual([
      '姓名',
      '邮箱',
      '学校',
      '开始',
      '结束',
      '项目名',
      '职责与成果',
      '用到的技术',
      '专业技能',
    ]);

    // 两个 month 字段（开始 / 结束）必须是原生 month 控件：图省事用 text 会丢掉浏览器日历
    expect(container.querySelectorAll('input[type="month"]')).toHaveLength(2);
    expect(container.querySelectorAll('input[type="text"]').length).toBeGreaterThanOrEqual(5);

    // rich_bullets 用 textarea（不是富文本容器）
    expect(container.querySelectorAll('textarea').length).toBeGreaterThanOrEqual(2);
  });

  it('★ text / month 复用的是既有 <Field>（结构证据：控件包在 label.field 里，没有第二个文本控件实现）', async () => {
    await render();
    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="例：张三"]')!;
    const label = nameInput.closest('label.field');
    expect(label).not.toBeNull();
    expect(label?.querySelector('.field__label')?.textContent).toBe('姓名');

    const [monthInput] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="month"]'));
    expect(monthInput.closest('label.field')).not.toBeNull();
    // 5 种字段类型 → 组件里只有 3 个新控件（Bullets / Tags / Photo），其余都走 Field
    expect(container.querySelectorAll('.bullets').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.tags').length).toBeGreaterThan(0);
  });

  it('schema 换一套，控件就换一批（组件里没有 if (templateId)）', async () => {
    await render([
      { type: 'awards', repeatable: true, fields: [{ key: 'awardName' }, { key: 'awardAt' }] },
    ]);
    const labels = Array.from(container.querySelectorAll('.field__label')).map((el) => el.textContent);
    expect(labels).toEqual(['奖项', '获得时间']);
    expect(container.querySelectorAll('input[type="month"]')).toHaveLength(1);
  });

  it('板块名可改；改完留空 → title 键被删掉（回落到模板板块名）', async () => {
    await render();
    const titleInput = container.querySelector<HTMLInputElement>('input[aria-label="板块名：教育经历"]')!;
    expect(titleInput.value).toBe('');
    expect(titleInput.placeholder).toBe('教育经历');

    await act(async () => setValue(titleInput, '实习 / 项目'));
    expect(section('education').title).toBe('实习 / 项目');

    await act(async () => setValue(titleInput, ''));
    expect(section('education')).not.toHaveProperty('title');
  });

  /* ------------------------------ 文本 / 月份 ------------------------------ */

  it('★ 文本字段边打边回传（live）：输入即更新，不等失焦（验收 6 的前提）', async () => {
    await render();
    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="例：张三"]')!;
    await act(async () => setValue(nameInput, '张'));
    expect(section('basics').items[0].fields.name).toBe('张');
    await act(async () => setValue(nameInput, '张三'));
    expect(section('basics').items[0].fields.name).toBe('张三');
  });

  it('必填未填只提示「未填」，输入后提示消失，且从头到尾都能保存', async () => {
    await render();
    expect(container.querySelectorAll('.resume-form__missing').length).toBe(2); // 姓名 + 学校
    expect(container.querySelector('.resume-form__missing')?.textContent).toContain('未填');

    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="例：张三"]')!;
    await act(async () => setValue(nameInput, '张三'));
    expect(container.querySelectorAll('.resume-form__missing').length).toBe(1);
  });

  it('month 字段写回的是 YYYY-MM 字符串（不远行加工、不转 Date）', async () => {
    await render();
    const [start] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="month"]'));
    await act(async () => setValue(start, '2022-09'));
    expect(section('education').items[0].fields.startMonth).toBe('2022-09');
  });

  /* ------------------------------ rich_bullets ------------------------------ */

  it('★ rich_bullets：加 5 条 → 删第 2 条 → 上移第 4 条，数据顺序与操作一致（验收 5）', async () => {
    await render();
    const descId = () =>
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="第 1 条要点"]');
    expect(descId()).not.toBeNull();

    // 空数组时已经渲染一行空行，所以只需要再加 4 条就凑满 5 行
    const projectRow = () => block(2).querySelectorAll<HTMLTextAreaElement>('.bullets__text');
    expect(projectRow()).toHaveLength(1);
    for (let i = 0; i < 4; i += 1) click(block(2).querySelector('.bullets__foot .btn'));
    expect(projectRow()).toHaveLength(5);
    for (let i = 0; i < 5; i += 1) {
      await act(async () => setValue(projectRow()[i], `要点 ${i + 1}`));
    }
    // 第一段（教育经历）没有 bullets 字段，取第 2 组
    const bullets = () => section('project').items[0].bullets ?? [];
    expect(bullets()).toEqual(['要点 1', '要点 2', '要点 3', '要点 4', '要点 5']);

    // 删第 2 条
    click(block(2).querySelector('[aria-label="删除第 2 条要点"]'));
    expect(bullets()).toEqual(['要点 1', '要点 3', '要点 4', '要点 5']);

    // 上移第 4 条（当前是「要点 5」）→ 变成 1,3,5,4
    click(block(2).querySelector('[aria-label="上移第 4 条要点"]'));
    expect(bullets()).toEqual(['要点 1', '要点 3', '要点 5', '要点 4']);
  });

  it('每条要点有可访问名字（aria-label 带序号），↑↓ 在首尾禁用', async () => {
    await render();
    click(block(2).querySelector('.bullets__foot .btn'));
    const rows = Array.from(block(2).querySelectorAll('.bullets__text'));
    expect(rows.map((el) => el.getAttribute('aria-label'))).toEqual(['第 1 条要点', '第 2 条要点']);
    expect(block(2).querySelector<HTMLButtonElement>('[aria-label="上移第 1 条要点"]')!.disabled).toBe(true);
    expect(block(2).querySelector<HTMLButtonElement>('[aria-label="下移第 2 条要点"]')!.disabled).toBe(true);
  });

  it('删掉唯一一条要点也不会让控件消失（又渲染一行空行，可以继续输入）', async () => {
    await render();
    click(block(3).querySelector('.bullets__foot .btn'));
    expect(block(3).querySelectorAll('.bullets__text')).toHaveLength(2);
    click(block(3).querySelector('[aria-label="删除第 1 条要点"]'));
    click(block(3).querySelector('[aria-label="删除第 1 条要点"]'));
    expect(block(3).querySelectorAll('.bullets__text')).toHaveLength(1);
  });

  /* ------------------------------ tags ------------------------------ */

  it('★ tags：输入即写回原始串，失焦规范化成「逗号 + 空格」，并显示解析出的标签', async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="React, TypeScript, Vite"]')!;

    await act(async () => setValue(input, 'React,, TypeScript ，Vue'));
    expect(section('project').items[0].fields.techStack).toBe('React,, TypeScript ，Vue');

    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(section('project').items[0].fields.techStack).toBe('React, TypeScript, Vue');

    const chips = Array.from(container.querySelectorAll('.tags__chip')).map((el) => el.textContent);
    expect(chips).toEqual(['React', 'TypeScript', 'Vue']);
  });

  /* ------------------------------ image 占位 ------------------------------ */

  it('image 字段渲染的是「未启用」占位，而不是一个点了没反应的假上传', async () => {
    await render([{ type: 'basics', repeatable: false, fields: [{ key: 'photo' }] }]);
    const button = container.querySelector<HTMLButtonElement>('.photo button')!;
    expect(button.textContent).toBe('选择图片');
    expect(button.disabled).toBe(true);
    // 写法提示与「未启用」说明都要在（两条 hint 各司其职，不能互相顶掉）
    expect(container.querySelector('.photo')?.textContent).toContain('暂未启用');
    expect(container.querySelector('.photo')?.textContent).toContain('证件照');
  });

  /* ------------------------------ 重复条目 ------------------------------ */

  it('★ 重复板块：加一条 → 上移 → 删除，条目顺序与内容跟着走', async () => {
    await render();
    const schoolInputs = () =>
      Array.from(container.querySelectorAll<HTMLInputElement>('input[placeholder="例：北京邮电大学"]'));

    await act(async () => setValue(schoolInputs()[0], '北京邮电大学'));
    click(container.querySelector('.resume-form__add'));
    expect(section('education').items).toHaveLength(2);
    await act(async () => setValue(schoolInputs()[1], '清华大学'));

    const [firstId, secondId] = section('education').items.map((item) => item.id);
    click(container.querySelector('[aria-label="上移第 2 条"]'));
    expect(section('education').items.map((item) => item.id)).toEqual([secondId, firstId]);
    expect(section('education').items.map((item) => item.fields.school)).toEqual([
      '清华大学',
      '北京邮电大学',
    ]);

    click(container.querySelector('[aria-label="删除第 1 条"]'));
    expect(section('education').items).toHaveLength(1);
    expect(section('education').items[0].fields.school).toBe('北京邮电大学');
  });

  it('非重复板块不渲染条目操作（基本信息没有「上移第 1 条」）', async () => {
    await render();
    expect(block(0).querySelector('[aria-label="上移第 1 条"]')).toBeNull();
    expect(block(0).querySelector('.resume-form__item-head')).toBeNull();
    expect(block(1).querySelector('[aria-label="上移第 1 条"]')).not.toBeNull();
    expect(container.querySelectorAll('.resume-form__add')).toHaveLength(2); // 教育 + 项目
  });

  it('板块里一条不剩时只剩「+ 加一条」，不崩、不留空白卡片', async () => {
    await render();
    click(container.querySelector('[aria-label="删除第 1 条"]'));
    expect(container.querySelectorAll('input[placeholder="例：北京邮电大学"]')).toHaveLength(0);
    click(container.querySelector('.resume-form__add'));
    expect(container.querySelectorAll('input[placeholder="例：北京邮电大学"]')).toHaveLength(1);
  });

  it('★ 编辑已有内容不新增任何 section/item（渲染器只改值，不造结构）', async () => {
    await render();
    const before = JSON.stringify(latest.sections.map((item) => [item.id, item.items.map((i) => i.id)]));
    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="例：张三"]')!;
    await act(async () => setValue(nameInput, '李四'));
    expect(section('basics').items[0].fields.name).toBe('李四');
    const after = JSON.stringify(latest.sections.map((item) => [item.id, item.items.map((i) => i.id)]));
    expect(after).toBe(before);
  });
});
