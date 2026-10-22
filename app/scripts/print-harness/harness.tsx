/**
 * 打印/布局门禁的宿主页（**只给 `smoke-print.mjs` 用，不进产物**）。
 *
 * 为什么需要它：`@media print` 与 3 种 layout 的真相只有真浏览器能验证
 * （jsdom 不评估媒体查询、没有布局）。
 *
 * ★ T05 之后 A4Preview 已经进了产物（`dist/index.html` 里有真实的 `.a4` 了），
 *   但**这个宿主页仍然必要** —— 理由从「组件还没有生产消费方」换成了「夹具确定性」：
 *   ① 产品路径要先在 localStorage 里塞一份简历、进简历页、再点开某份简历，
 *      每套模板还得点一次模板卡等 400 ms 防抖落库 —— 8 套模板就是 8 次交互耦合，
 *      任何一次 UI 改动都会让打印门禁红，但它红的原因和打印无关；
 *   ② 更致命的是**空简历只有 1 页**：拿产品的默认状态验「分页保护」，
 *      「预览页数 = 打印页数」会退化成永真断言（1 = 1），假通过比红更糟；
 *   本文件的样例内容刻意写到溢出两页，分页断言才有意义。
 *
 *   所以分工是：`smoke-print.mjs` 的【①】跑**真实产物**做静态检查（`@page` 唯一、
 *   打印规则在场、零外部请求），【②–⑤】跑本宿主页做**逐模板的布局与出纸**验证。
 *
 * 这里用 esbuild 现场把**真组件 + 真样式**打成一个页面（同一份
 * `A4Preview.tsx` / `TemplatePicker.tsx` / `styles.css`，一个字节都没换），
 * 由 `smoke-print.mjs` 逐套模板驱动（`?tpl=<templateId>` 选模板）：
 *   - `Emulation.setEmulatedMedia({ media: 'print' })` → 量 computed style
 *   - `Page.printToPDF` → 确认真的能出纸
 *
 * ★ 它不在 `vite build` 的入口图里（`index.html` 不 import 它），对产物体积零贡献；
 *   `tsconfig.json` 的 include 覆盖 `scripts/`，所以它照样过 `tsc --noEmit`。
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ResumeContent, ResumeSectionType, TemplateId } from '../../src/types';
import { addItem, ensureSectionsWith, sectionOf, setBullets, setField } from '../../src/resume/schema';
import { FIELD_META, type FieldKey, section as declareSection } from '../../src/resume/templates/base';
import { TEMPLATES, TEMPLATE_ORDER, sectionsOf } from '../../src/resume/templates';
import { A4Preview } from '../../src/components/resume/A4Preview';
import { SchemaForm } from '../../src/components/resume/SchemaForm';
import { TemplatePicker } from '../../src/components/resume/TemplatePicker';
import { PrintButton } from '../../src/components/resume/PrintButton';
import '../../src/styles.css';

/** 1×1 白点 PNG：门禁只需要「有一个 data: 图片在纸上」，不需要真照片 */
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2wUAAAAASUVORK5CYII=';

/** 每个字段一份像人写的样例（门禁要的是「排版真实」，不是「值好看」也无所谓） */
const SAMPLE: Record<FieldKey, string> = {
  name: '林一舟',
  phone: '138 0000 0000',
  email: 'yizhou.lin@example.com',
  city: '杭州',
  photo: PHOTO,
  school: '北京邮电大学',
  major: '计算机科学与技术',
  degree: '本科',
  startMonth: '2022-09',
  endMonth: '2026-06',
  gpa: '3.8/4.0（专业前 5%）',
  org: '字节跳动 · 抖音电商',
  role: '前端开发实习生',
  description: '把首屏 FCP 从 1.8s 压到 0.9s',
  techStack: 'React, TypeScript, Vite',
  projectName: '单文件简历工作台',
  link: 'github.com/example/job-desk',
  skillsText: '熟练：TypeScript / React / Vite',
  awardName: '蓝桥杯省一',
  awardAt: '2024-05',
  paperTitle: '基于 XXX 的 YYY 研究',
  paperWhere: '某学报 2025 年第 3 期',
  coursesText: '数据结构, 操作系统, 计算机网络',
  customTitle: '开源贡献',
  customText: '给 Vite 提过一个构建缓存的小修复',
};

const SECTION_TYPES: ResumeSectionType[] = [
  'basics',
  'education',
  'experience',
  'project',
  'skills',
  'campus',
  'awards',
  'papers',
  'courses',
  'custom',
];

const REPEATABLE = new Set<ResumeSectionType>(['education', 'experience', 'project', 'campus', 'awards', 'papers']);

const ALL_KEYS = Object.keys(FIELD_META).join(',');

/**
 * 造一份「所有板块、所有字段都有内容」的简历 —— 目的不是好看，
 * 而是让**每套模板**都撑到一页以上：只有跨页时，分页保护与溢出断言才有意义。
 */
function seedContent(): ResumeContent {
  const union = SECTION_TYPES.map((type) => declareSection(type, REPEATABLE.has(type), ALL_KEYS));
  let content = ensureSectionsWith({ sections: [] }, union);

  for (const type of SECTION_TYPES) {
    const sectionId = content.sections.find((item) => item.type === type)!.id;
    // 重复板块补到 3 条（多条目才测得出「条目不跨页」）
    const target = REPEATABLE.has(type) ? 3 : 1;
    while (sectionOf(content, sectionId)!.items.length < target) {
      content = addItem(content, sectionId);
    }
    for (const item of sectionOf(content, sectionId)!.items) {
      for (const key of Object.keys(FIELD_META) as FieldKey[]) {
        if (FIELD_META[key].type === 'rich_bullets') {
          content = setBullets(content, sectionId, item.id, [
            `${SAMPLE[key]}：第一条要点，写清楚做了什么、怎么做的`,
            `${SAMPLE[key]}：第二条要点，带一个数字（把 1.8s 压到 0.9s）`,
          ]);
        } else {
          content = setField(content, sectionId, item.id, key, SAMPLE[key]);
        }
      }
    }
  }

  return content;
}

const SEED = seedContent();

/**
 * `?tpl=<templateId>` 选模板（也接受 `#id`）；不认识就落 tech-single（门禁不该因为地址栏手改而白跑）。
 *
 * ★ 用 query 而不是 hash：hash 变化是**同文档导航**，模块不会重跑，
 *   门禁脚本就得自己去 setState —— 那样测的就不是「打开这套模板」了。
 */
function templateFromLocation(): TemplateId {
  const fromQuery = new URLSearchParams(location.search).get('tpl');
  const id = (fromQuery ?? location.hash.replace(/^#/, '')) as TemplateId;
  return TEMPLATE_ORDER.includes(id) ? id : 'tech-single';
}

function Harness() {
  const [templateId, setTemplateId] = useState<TemplateId>(templateFromLocation);
  const [content, setContent] = useState<ResumeContent>(SEED);

  // 首帧之后再置就绪标记：smoke 脚本轮询它，避免「React 还没渲染就量样式」
  useEffect(() => {
    document.documentElement.dataset.harnessReady = '1';
  }, []);

  // 切模板只补板块、不改内容（与产品行为一致），这样 8 套量的是同一份数据
  const sections = sectionsOf(templateId);

  return (
    <div className="resume">
      {/* 模板选择器放进 `.resume__toolbar`（真实视图里它就挂在工具条上）：
          打印 CSS 只摘 `.resume__toolbar` / `.resume__form` / `.print-entry` 这些壳，
          所以它必须待在壳里，否则会跟着内容一起印到纸上 ——
          门禁的「打印页数 = 预览页数」就是被这个多出来的卡片网格顶多了一页（实测）。 */}
      <div className="resume__toolbar">
        <TemplatePicker
          value={templateId}
          onChange={(id) => {
            setTemplateId(id);
            setContent((current) => ensureSectionsWith(current, sectionsOf(id)));
          }}
        />
        <PrintButton onBeforePrint={() => undefined} />
      </div>
      <SchemaForm sections={sections} content={content} onChange={setContent} />
      <A4Preview content={content} templateId={templateId} />
    </div>
  );
}

/**
 * 把模板清单（id / 布局 / 名称）暴露给门禁脚本。
 *
 * 为什么不是脚本里再抄一份 8 行：抄一份就有一份会漂移的真相 ——
 * 改了 layout 之后脚本还在按老报表断言，绿得毫无意义。
 */
(window as unknown as { __templates?: unknown }).__templates = TEMPLATE_ORDER.map((id) => ({
  id,
  layout: TEMPLATES[id].layout,
  name: TEMPLATES[id].name,
}));

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');
createRoot(container).render(<Harness />);
