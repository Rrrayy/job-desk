/**
 * `tech-double` 技术双栏（P1）。
 *
 * 内容多到单栏装不下的技术简历：左栏是教育/经历/项目（正文流），
 * 右栏落下技能/奖项这类短块。双栏是**同一份 DOM 的 CSS 分栏**（`.a4--double`），
 * 不是第二套渲染器 —— 换模板永远不重建内容。
 */

import type { Template } from '../../types';
import { section } from './base';
import { thumbOf } from './thumbs';

export const techDouble: Template = {
  id: 'tech-double',
  name: '技术双栏',
  targetDirection: '前端 · 全栈 · 想一页装下更多',
  layout: 'double',
  thumbnail: thumbOf('double', '#3d47b8'),
  schema: {
    sections: [
      section('basics', false, 'name*,phone*,email*,city'),
      section('education', true, 'school*,major,degree,startMonth,endMonth,gpa'),
      section('experience', true, 'org*,role,startMonth,endMonth,description*,techStack'),
      section('project', true, 'projectName*,role,description*,techStack,link'),
      section('skills', false, 'skillsText*'),
      section('awards', true, 'awardName,awardAt'),
    ],
  },
  printRules: { breakAvoid: ['.rs-item', '.rs-section'], pageMarginMm: 14 },
};
