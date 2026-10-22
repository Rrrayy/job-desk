/**
 * `creative` 创意个性（P1）—— **唯一带照片的模板**（ARCH Q8 裁决）。
 *
 * 双栏 + 色块（`.a4[data-tpl='creative']`）+ 一块自定义板块（开源贡献 / 作品集 / 副业）。
 * 照片走 `PhotoField`：读取即压缩到宽 ≤480px、单张 ≤80 KB，超限**拒绝并说明**
 * （不静默降级：localStorage 配额是整个库的公共资源，一张 4 MB 的原图能挤掉半个库）。
 *
 * 为什么照片只在这里：技术/学术/社招简历里的照片只会分散注意力，
 * 而且不同渠道对要不要照片的口径完全相反 —— 与其猜，不如只给需要它的模板。
 */

import type { Template } from '../../types';
import { section } from './base';
import { thumbOf } from './thumbs';

export const creative: Template = {
  id: 'creative',
  name: '创意个性',
  targetDirection: '设计 · 内容 · 想有点个性',
  layout: 'double',
  thumbnail: thumbOf('double', '#e5484d'),
  schema: {
    sections: [
      section('basics', false, 'name*,phone,email,city,photo'),
      section('experience', true, 'org*,role,startMonth,endMonth,description*,techStack'),
      section('project', true, 'projectName*,role,description,link'),
      section('custom', false, 'customTitle,customText', {
        customTitle: { label: '板块名', placeholder: '例：作品集 / 开源贡献' },
      }),
      section('skills', false, 'skillsText'),
      section('education', true, 'school,major,startMonth,endMonth'),
    ],
  },
  printRules: { breakAvoid: ['.rs-item', '.rs-section'], pageMarginMm: 14 },
};
