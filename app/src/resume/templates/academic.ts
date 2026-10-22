/**
 * `academic` 学术科研（P1）。
 *
 * 读研/申博/科研岗：**论文/课题**放在教育之后（这是筛人的第一关），
 * 项目块按「科研项目」改写（带链接，方便点开看 demo 或 preprint），
 * 教育里专业必填、绩点保留 —— 学术路径上看的就是学校、导师方向、绩点。
 */

import type { Template } from '../../types';
import { section } from './base';
import { thumbOf } from './thumbs';

export const academic: Template = {
  id: 'academic',
  name: '学术科研',
  targetDirection: '读研 · 申博 · 科研岗',
  layout: 'single',
  thumbnail: thumbOf('single', '#6b7285'),
  schema: {
    sections: [
      section('basics', false, 'name*,phone*,email*,city'),
      section('education', true, 'school*,major*,degree,startMonth,endMonth,gpa'),
      section('papers', true, 'paperTitle*,paperWhere', {
        paperTitle: { label: '论文/课题', placeholder: '例：基于 XXX 的 YYY 研究（一作）' },
      }),
      section('project', true, 'projectName*,role,startMonth,endMonth,description,link', {
        projectName: { label: '项目/课题', placeholder: '例：国家自然科学基金课题' },
        role: { label: '承担角色', placeholder: '例：主要参与者' },
        link: { label: '代码/预印本', placeholder: '例：arxiv.org/abs/xxxx' },
      }),
      section('awards', true, 'awardName,awardAt'),
      section('courses', false, 'coursesText'),
      section('skills', false, 'skillsText'),
    ],
  },
  printRules: { breakAvoid: ['.rs-item', '.rs-section'], pageMarginMm: 14 },
};
