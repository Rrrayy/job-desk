/**
 * 打印门禁的宿主页（**只给 `smoke-print.mjs` 用，不进产物**）。
 *
 * 为什么需要它：`@media print` 的真相只有真浏览器能验证（jsdom 不评估媒体查询），
 * 而 T03 时点的 `A4Preview` 还没有生产消费方（T05 的 ResumeEditor 才会挂上去），
 * 所以 `dist/index.html` 里根本没有 `.a4` 元素 —— 拿真实产物跑打印断言会
 * 「断言一个不存在的元素」，那是最糟的一种假测试。
 *
 * 于是这里用 **esbuild 现场把真组件 + 真样式打成一个页面**（同一个
 * `A4Preview.tsx`、同一个 `styles.css`，一个字节都没换），再由
 * `smoke-print.mjs` 用 `Emulation.setEmulatedMedia({ media: 'print' })` 驱动。
 * 宿主页里连 `<SchemaForm>` 都是真组件：打印规则要隐藏的 `.resume__form`
 * 就是它渲染出来的那个节点，不是我手写的假 div。
 *
 * ★ 它不在 `vite build` 的入口图里（`index.html` 不 import 它），
 *   所以对产物体积零贡献；`tsconfig.json` 的 include 覆盖 `scripts/`，
 *   所以它照样过 `tsc --noEmit`（组件 prop 改错会在这里先炸）。
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ResumeContent } from '../../src/types';
import { addItem, ensureSectionsWith, sectionOf, setBullets, setField } from '../../src/resume/schema';
import { BASE_SECTIONS } from '../../src/resume/templates/base';
import { A4Preview } from '../../src/components/resume/A4Preview';
import { SchemaForm } from '../../src/components/resume/SchemaForm';
import { PrintButton } from '../../src/components/resume/PrintButton';
import '../../src/styles.css';

/**
 * 造一份「打印出来一定超过一页」的简历。
 *
 * 目的不是好看，而是让分页真的发生：只有跨页时，
 * 「.rs-item 不被切断」「分页装饰消失」这些断言才有意义。
 */
function seedContent(): ResumeContent {
  // ensureSectionsWith 给每个板块建好一条空条目；更靠后的条目用 addItem 追加
  let content = ensureSectionsWith({ sections: [] }, BASE_SECTIONS);

  const sectionIdOf = (type: string): string => content.sections.find((item) => item.type === type)!.id;

  const fill = (type: string, index: number, fields: Record<string, string>, bullets?: string[]) => {
    const sectionId = sectionIdOf(type);
    while (sectionOf(content, sectionId)!.items.length <= index) {
      content = addItem(content, sectionId);
    }
    const itemId = sectionOf(content, sectionId)!.items[index].id;
    for (const [key, value] of Object.entries(fields)) {
      content = setField(content, sectionId, itemId, key, value);
    }
    if (bullets) content = setBullets(content, sectionId, itemId, bullets);
  };

  fill('basics', 0, { name: '林一舟', phone: '138 0000 0000', email: 'yizhou.lin@example.com', city: '杭州' });

  fill('education', 0, {
    school: '北京邮电大学',
    major: '计算机科学与技术',
    degree: '本科',
    startMonth: '2022-09',
    endMonth: '2026-06',
    gpa: '3.8/4.0（专业前 5%）',
  });

  const experiences: [Record<string, string>, string[]][] = [
    [
      { org: '字节跳动 · 抖音电商', role: '前端开发实习生', startMonth: '2025-03', endMonth: '2025-08', techStack: 'React, TypeScript, Vite' },
      [
        '把商品详情页首屏 FCP 从 1.8s 压到 0.9s：拆掉三个同步渲染的埋点模块，改成空闲回调里批量上报',
        '重写 SKU 选择器：把 12 个互相拷贝的 useState 收敛成一个 reducer，交互回归用例从 0 条补到 34 条',
        '搭了一套基于 esbuild 的组件级快照脚本，把设计走查的返工轮次从平均 3 轮降到 1 轮',
      ],
    ],
    [
      { org: '某创业公司', role: '全栈实习生', startMonth: '2024-09', endMonth: '2025-01', techStack: 'Node.js, SQLite' },
      [
        '独立做完内部工单系统的前端与接口，把运营同学每天手工汇总的 40 分钟压缩到一次导出',
        '给表单加了字段级校验与草稿自动保存，提交失败率从 11% 降到 2%',
      ],
    ],
    [
      { org: '实验室 · 人机交互组', role: '学生研究员', startMonth: '2024-03', endMonth: '2024-08' },
      [
        '负责实验平台的采集端，用 Web Worker 把高频鼠标轨迹采样从掉帧 20% 变成不掉帧',
        '整理 32 名被试的数据清洗脚本，可复现地跑出论文里那三张图和一组显著性检验结果',
      ],
    ],
  ];
  experiences.forEach(([fields, bullets], index) => fill('experience', index, fields, bullets));

  const projects: [Record<string, string>, string[]][] = [
    [
      { projectName: '单文件简历工作台', role: '个人项目', startMonth: '2025-06', techStack: 'React, Vite, CDP', link: 'github.com/example/job-desk' },
      [
        '把投递、面试、面经、简历收进一个 600 KB 的单文件 HTML，双击即用，数据只落在自己的浏览器里',
        '用 CDP 直接驱动 headless 浏览器做门禁：性能基准、打印分页、零外部请求，全部脚本化',
      ],
    ],
    [
      { projectName: '校园二手交易小程序', role: '前端负责人', startMonth: '2023-09', endMonth: '2024-01' },
      [
        '上线 4 个月累计 2300 名注册用户，日活在开学季峰值 400',
        '把列表页的图片加载改成按视口懒加载 + 本地缓存，低端机上滑动帧率从 38 提到 57',
      ],
    ],
  ];
  projects.forEach(([fields, bullets], index) => fill('project', index, fields, bullets));

  const skillsId = sectionIdOf('skills');
  const skillsItemId = sectionOf(content, skillsId)!.items[0].id;
  content = setBullets(content, skillsId, skillsItemId, [
    '熟练：TypeScript / React / Vite，能手写可维护的状态层与构建脚本',
    '熟悉：Node.js 服务端与 SQLite，写过采集、清洗、导出整条数据链路',
    '了解：Rust 基础语法、浏览器渲染管线与打印排版（@page / 分页保护）',
  ]);

  return content;
}

const SEED = seedContent();

function Harness() {
  const [content, setContent] = useState<ResumeContent>(SEED);

  // 首帧之后再置就绪标记：smoke 脚本轮询它，避免「React 还没渲染就量样式」
  useEffect(() => {
    document.documentElement.dataset.harnessReady = '1';
  }, []);

  return (
    <div className="resume">
      <SchemaForm sections={BASE_SECTIONS} content={content} onChange={(next) => setContent(next)} />
      <div className="resume__toolbar">
        <PrintButton onBeforePrint={() => undefined} />
      </div>
      <A4Preview content={content} templateId="minimal-bw" />
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');
createRoot(container).render(<Harness />);
