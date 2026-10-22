/**
 * `minimal-bw` 黑白极简（P0）。
 *
 * 保底模板：**零颜色、零装饰、零必填**。任何打印机、任何投递渠道都不会翻车，
 * 也是「格式解析」类 ATS 最友好的形状（纯文本层级，没有色块干扰）。
 *
 * 全部字段都不设必填：这套模板的定位是「先把内容写出来」，
 * 用占位提示反而不符合它的气质（一条灰字比「未填：姓名」更像简历）。
 */

import type { Template } from '../../types';
import { section } from './base';
import { thumbOf } from './thumbs';

export const minimalBw: Template = {
  id: 'minimal-bw',
  name: '黑白极简',
  targetDirection: '通用保底 · 打印零风险',
  layout: 'single',
  thumbnail: thumbOf('single', '#1b1f2a'),
  schema: {
    sections: [
      section('basics', false, 'name,phone,email,city'),
      section('education', true, 'school,major,degree,startMonth,endMonth,gpa'),
      section('experience', true, 'org,role,startMonth,endMonth,description'),
      section('project', true, 'projectName,role,description'),
      section('skills', false, 'skillsText'),
      section('awards', true, 'awardName,awardAt'),
    ],
  },
  printRules: { breakAvoid: ['.rs-item', '.rs-section'], pageMarginMm: 14 },
};
