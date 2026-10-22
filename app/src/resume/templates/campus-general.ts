/**
 * `campus-general` 校招通用（P0）。
 *
 * 实习/校招里「还没定方向」的主力模板：把**校园经历**提到实习前面，
 * 主修课程单独成块（很多校招 JD 会按课程筛人），专业必填。
 * 双栏布局：右栏放技能/课程/奖项这类短块，左栏放经历。
 */

import type { Template } from '../../types';
import { section } from './base';
import { thumbOf } from './thumbs';

export const campusGeneral: Template = {
  id: 'campus-general',
  name: '校招通用',
  targetDirection: '实习 · 校招 · 方向待定',
  layout: 'double',
  thumbnail: thumbOf('double', '#1f9d55'),
  schema: {
    sections: [
      section('basics', false, 'name*,phone*,email*,city'),
      section('education', true, 'school*,major*,degree,startMonth,endMonth,gpa'),
      section('campus', true, 'org*,role,startMonth,endMonth,description', {
        org: { label: '组织/社团', placeholder: '例：学生会技术部' },
        role: { label: '担任角色', placeholder: '例：部长' },
      }),
      section('experience', true, 'org,role,startMonth,endMonth,description'),
      section('project', true, 'projectName,role,description,techStack'),
      section('skills', false, 'skillsText'),
      section('courses', false, 'coursesText'),
      section('awards', true, 'awardName,awardAt'),
    ],
  },
  // 校园模板的板块碎，`break-inside` 也要护住整块（碎块被切开最难看）
  printRules: { breakAvoid: ['.rs-item', '.rs-section'], pageMarginMm: 14 },
};
