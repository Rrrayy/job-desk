/**
 * `product-ops` 产品运营（P1）。
 *
 * 非技术方向的字段集：经历里「岗位/角色」必填（产品/运营简历的第一眼就是这个），
 * 技术栈换成可选的标签（做增长的人也可能写 SQL / 数据工具），
 * 并且给一块**自定义板块**（`custom`）放「数据案例 / 增长复盘」这类模板之外的表达。
 */

import type { Template } from '../../types';
import { section } from './base';
import { thumbOf } from './thumbs';

export const productOps: Template = {
  id: 'product-ops',
  name: '产品运营',
  targetDirection: '产品 · 运营 · 增长',
  layout: 'double',
  thumbnail: thumbOf('double', '#f5a524'),
  schema: {
    sections: [
      section('basics', false, 'name*,phone*,email*,city'),
      section('experience', true, 'org*,role*,startMonth,endMonth,description*,techStack', {
        techStack: { label: '用到的工具', placeholder: 'SQL, Excel, Figma' },
      }),
      section('project', true, 'projectName*,role,startMonth,endMonth,description*'),
      section('custom', false, 'customTitle,customText', {
        customTitle: { label: '板块名', placeholder: '例：增长案例' },
        customText: { label: '内容', placeholder: '一条一个要点' },
      }),
      section('skills', false, 'skillsText'),
      section('education', true, 'school,major,degree,startMonth,endMonth'),
      section('awards', true, 'awardName,awardAt'),
    ],
  },
  printRules: { breakAvoid: ['.rs-item', '.rs-section'], pageMarginMm: 14 },
};
