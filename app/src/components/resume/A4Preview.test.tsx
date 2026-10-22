// @vitest-environment jsdom
/**
 * A4 预览（画布结构层）。
 *
 * jsdom 没有布局、没有媒体查询，所以这里**只**断言 DOM 结构与文本：
 * 板块顺序、要点顺序、标签连接符、必填占位、空白板块不占版面、`aria-hidden`。
 * 「打印时装饰真的消失」「分页真的不切断」是布局真相，归 smoke-print.mjs（L2）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResumeContent } from '../../types';
import { ensureSectionsWith, setBullets, setField, setSectionTitle } from '../../resume/schema';
import { BASE_SECTIONS } from '../../resume/templates/base';
import { PAGE_CONTENT_PX, pageTopPx } from '../../resume/print';
import { A4Preview, A4_MIN_SCALE, A4_WIDTH_PX, clampScale } from './A4Preview';

// React 18 要求宿主编译期/运行时显式声明「这里是 act 环境」，否则每次 act
// 都会打印一条 warning。本文件用裸 react-dom/client（没有 testing-library）→ 自己声明。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function emptyResume(): ResumeContent {
  return ensureSectionsWith({ sections: [] }, BASE_SECTIONS);
}

function sectionOfContent(content: ResumeContent, type: string) {
  return content.sections.find((item) => item.type === type)!;
}

describe('A4Preview（jsdom）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(content: ResumeContent, templateId: 'minimal-bw' = 'minimal-bw'): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(<A4Preview content={content} templateId={templateId} />);
    });
  }

  it('★ 画布骨架：.a4-fit > .a4 > .a4__body，且整块对屏幕阅读器隐藏（同一内容左侧表单已有）', async () => {
    await render(emptyResume());
    const fit = container.querySelector('.a4-fit')!;
    const a4 = fit.querySelector('.a4')!;
    expect(a4.className).toContain('a4--single');
    expect(a4.getAttribute('aria-hidden')).toBe('true');
    expect(a4.querySelector('.a4__body')).not.toBeNull();
    // 未登记模板 → 回落到基座 schema，绝不渲染一张空白纸
    expect(container.querySelectorAll('.rs-section').length).toBeGreaterThan(0);
  });

  it('板块按 schema 顺序渲染；用户改过的板块名优先于模板名', async () => {
    let content = emptyResume();
    content = setField(content, sectionOfContent(content, 'basics').id, sectionOfContent(content, 'basics').items[0].id, 'name', '张三');
    content = setSectionTitle(content, sectionOfContent(content, 'experience').id, '实习经历');
    content = setField(content, sectionOfContent(content, 'experience').id, sectionOfContent(content, 'experience').items[0].id, 'org', '字节跳动');

    await render(content);

    const titles = Array.from(container.querySelectorAll('.rs-section__title')).map((el) => el.textContent);
    // 顺序 = BASE_SECTIONS 顺序；用户改过的板块名（实习经历）盖掉模板名（实习/工作经历）。
    // 教育/项目虽未填，但它们的必填字段（学校 / 项目名）还空着 → 仍要占位，
    // 「纸上看得见缺什么」比「排版好看」优先（见下一条断言）。
    expect(titles).toEqual(['基本信息', '教育经历', '实习经历', '项目经历']);
    // 技能 / 奖项整块没有任何必填字段、也没填内容 → 不占版面
    expect(titles).not.toContain('专业技能');
    expect(titles).not.toContain('奖项荣誉');
  });

  it('★ rich_bullets：纸上顺序 = 数据顺序（增删移序之后仍然一致）', async () => {
    let content = emptyResume();
    const experience = sectionOfContent(content, 'experience');
    content = setField(content, experience.id, experience.items[0].id, 'org', '字节跳动');
    content = setBullets(content, experience.id, experience.items[0].id, ['第一点', '第二点', '第三点']);

    await render(content);
    const bullets = Array.from(container.querySelectorAll('.rs-bullets')).map((el) => el.textContent);
    expect(bullets).toEqual(['第一点', '第二点', '第三点']);

    // 删中间一条 + 交换 → 纸上跟着变（预览永远从 content 渲染，没有第二份数据）
    content = setBullets(content, experience.id, experience.items[0].id, ['第三点', '第一点']);
    await act(async () => {
      root.render(<A4Preview content={content} templateId="minimal-bw" />);
    });
    expect(Array.from(container.querySelectorAll('.rs-bullets')).map((el) => el.textContent)).toEqual([
      '第三点',
      '第一点',
    ]);
  });

  it('tags 在纸上用「 · 」连接（逗号串是存储格式，不是排版格式）', async () => {
    let content = emptyResume();
    const experience = sectionOfContent(content, 'experience');
    content = setField(content, experience.id, experience.items[0].id, 'org', '字节跳动');
    content = setField(content, experience.id, experience.items[0].id, 'techStack', 'React, TypeScript');

    await render(content);
    expect(container.querySelector('.rs-item__tags')?.textContent).toBe('React · TypeScript');
  });

  it('★ 必填未填 → 浅色占位（不阻止保存，但纸上要看得见缺什么）', async () => {
    await render(emptyResume());
    const placeholders = Array.from(container.querySelectorAll('.rs-placeholder')).map((el) => el.textContent);
    // 基本信息缺姓名/电话/邮箱，教育缺学校，经历缺公司，项目缺项目名
    expect(placeholders.length).toBeGreaterThanOrEqual(4);
    expect(placeholders.join('|')).toContain('姓名');
    expect(placeholders.join('|')).toContain('学校');
  });

  it('非必填字段留空 → 什么都不渲染（不出现空行、空标签）', async () => {
    let content = emptyResume();
    const education = sectionOfContent(content, 'education');
    content = setField(content, education.id, education.items[0].id, 'school', '北京邮电大学');

    await render(content);
    const eduItem = container.querySelectorAll('.rs-item')[0];
    // 只有学校：没有 gpa / 专业 的空行
    expect(eduItem.querySelectorAll('.rs-item__line')).toHaveLength(0);
  });

  it('整个板块都空（连必填占位都没有）就不占版面 —— 空标题会让简历像没写完', async () => {
    const content = emptyResume();
    const awards = sectionOfContent(content, 'awards');
    expect(awards.items).toHaveLength(1);
    // awards 的 awardName / awardAt 都不是必填 → 整块空
    await render(content);
    const titles = Array.from(container.querySelectorAll('.rs-section__title')).map((el) => el.textContent);
    expect(titles).not.toContain('奖项荣誉');
  });

  it('分页信息：jsdom 量不到高度 → 1 页，一个页码、零分页线', async () => {
    await render(emptyResume());
    const fit = container.querySelector<HTMLElement>('.a4-fit')!;
    expect(fit.dataset.pages).toBe('1');
    expect(container.querySelectorAll('.a4__page-no')).toHaveLength(1);
    expect(container.querySelectorAll('.a4__guide')).toHaveLength(0);
  });

  it('★ 页数按「内容高度 / 一页可打印高度」算，分页线与页码落在同一把尺子上', async () => {
    // jsdom 没有布局 —— 把高度「假」到底才是这里唯一诚实的做法：
    // 钉一个 2.4 页的高度，断言页数与分页线位置都按 print.ts 的公式推导（预览与打印共用一把尺子）
    const original = Element.prototype.getBoundingClientRect;
    const height = PAGE_CONTENT_PX * 2.4;
    Element.prototype.getBoundingClientRect = function stubbed(): DOMRect {
      return { height, width: 0, top: 0, left: 0, bottom: height, right: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    try {
      await render(emptyResume());
      const fit = container.querySelector<HTMLElement>('.a4-fit')!;
      expect(fit.dataset.pages).toBe('3');
      expect(container.querySelectorAll('.a4__page-no')).toHaveLength(3);
      const guides = Array.from(container.querySelectorAll<HTMLElement>('.a4__guide'));
      expect(guides).toHaveLength(2);
      // 第 i 条线画在「第 i+1 页内容的起点」= 14mm + i × 269mm
      expect(guides[0].style.top).toBe(`${pageTopPx(1)}px`);
      expect(guides[1].style.top).toBe(`${pageTopPx(2)}px`);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('可以钉死缩放（测试/快照用）；不传则交给 ResizeObserver 写 CSS 变量', async () => {
    const content = emptyResume();
    await render(content);
    const fit = container.querySelector<HTMLElement>('.a4-fit')!;
    // jsdom 没有 ResizeObserver、父容器 clientWidth 恒为 0 → 兜底按 A4 原宽算，落回 1。
    // 「窗口变窄 → scale < 1 → 纸的布局宽跟着缩」是布局真相，归 smoke-print.mjs（L2）：
    // 这里量不出 clientWidth，写一条「假缩放断言」只会让人误以为它被测过了。
    expect(fit.style.getPropertyValue('--a4-scale') === '' || fit.style.getPropertyValue('--a4-scale') === '1').toBe(true);

    await act(async () => {
      root.render(<A4Preview content={content} templateId="minimal-bw" scale={0.6} />);
    });
    expect(fit.style.getPropertyValue('--a4-scale')).toBe('0.6');
  });

  it('clampScale：下限 0.35、上限 1、非法值回 1（不可读的缩放等于没有预览）', () => {
    expect(clampScale(0.1)).toBe(A4_MIN_SCALE);
    expect(clampScale(2)).toBe(1);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(0)).toBe(1);
    expect(clampScale(0.6249)).toBe(0.62);
    expect(A4_WIDTH_PX).toBeCloseTo(793.7, 1);
  });

  it('用 React.memo 包了一层（content 引用不变时不重渲 A4 子树）', () => {
    expect((A4Preview as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('照片字段本版不进预览（照片随 creative / T04）', async () => {
    let content = emptyResume();
    const basics = sectionOfContent(content, 'basics');
    content = setField(content, basics.id, basics.items[0].id, 'name', '张三');
    content = setField(content, basics.id, basics.items[0].id, 'photo', 'data:image/png;base64,AAAA');

    await render(content);
    expect(container.querySelector('.a4 img')).toBeNull();
    expect(container.querySelector('.a4__body')?.textContent).not.toContain('data:image');
  });
});
