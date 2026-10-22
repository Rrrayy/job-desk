/**
 * `tech-single` 技术单栏（P0）。
 *
 * 校招技术岗的默认形状：教育 → 实习 → 项目 → 技能 → 奖项。
 * 与基座的区别：项目里加了 `role`（在项目里担什么角色），经历/项目都要点必填
 * （技术简历里「只写公司名不写做了什么」是无效简历，占位得把它暴露出来）。
 */

import type { Template } from '../../types';
import { section } from './base';
import { thumbOf } from './thumbs';

export const techSingle: Template = {
  id: 'tech-single',
  name: '技术单栏',
  targetDirection: '后端 · 基础架构 · 校招技术岗',
  layout: 'single',
  thumbnail: thumbOf('single', '#4f5bd5'),
  schema: {
    sections: [
      section('basics', false, 'name*,phone*,email*,city'),
      section('education', true, 'school*,major,degree,startMonth,endMonth,gpa'),
      section('experience', true, 'org*,role,startMonth,endMonth,description*,techStack'),
      section('project', true, 'projectName*,role,startMonth,endMonth,description*,techStack,link'),
      section('skills', false, 'skillsText*'),
      section('awards', true, 'awardName,awardAt'),
    ],
  },
  printRules: { breakAvoid: ['.rs-item', '.rs-section'], pageMarginMm: 14 },
};
