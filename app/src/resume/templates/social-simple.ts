/**
 * `social-simple` 社招简洁（P0）。
 *
 * 有工作经验的人：经历必须排第一（招聘方只看这个），教育压到最后一行。
 * 时间轴布局：左侧一条导轨 + 每段经历一个圆点，读起来就是一条职业线。
 * 岗位/角色必填 —— 社招里「在哪家公司」不如「做的什么岗」关键。
 */

import type { Template } from '../../types';
import { section } from './base';
import { thumbOf } from './thumbs';

export const socialSimple: Template = {
  id: 'social-simple',
  name: '社招简洁',
  targetDirection: '有工作经验 · 一页交付',
  layout: 'timeline',
  thumbnail: thumbOf('timeline', '#3e8ede'),
  schema: {
    sections: [
      section('basics', false, 'name*,phone*,email*,city'),
      section('experience', true, 'org*,role*,startMonth*,endMonth,description*,techStack'),
      section('project', true, 'projectName,role,startMonth,endMonth,description'),
      section('skills', false, 'skillsText'),
      section('education', true, 'school,major,degree,startMonth,endMonth'),
    ],
  },
  printRules: { breakAvoid: ['.rs-item', '.rs-section'], pageMarginMm: 14 },
};
