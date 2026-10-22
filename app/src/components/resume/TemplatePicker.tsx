/**
 * 模板选择器（ARCH §4.0 T04）。
 *
 * 8 张卡片 = 缩略图 + 名称 + 目标方向 + 布局名。缩略图按 `layout` 生成
 * （`thumbs.ts`），所以「图上画的」与「实际渲染出来的」是构造上一致的。
 *
 * 三个刻意的取舍：
 * 1. **不做模板预览大图**：右侧 A4 就是预览，点一下卡片立刻看到真东西。
 *    再画一张大图既是第二份真相，也要多背几 KB。
 * 2. **切模板只改 `templateId`**（`onChange` 一个 id）：内容一个字段都不动，
 *    这是「数据是超集、模板只是视图」在 UI 层的唯一要求。
 * 3. **未登记 id 要说出来**：库里可能存着老/坏数据，`sectionsOf` 已回落到基座，
 *    这里再给一行明话，而不是让用户对着一个没人选中的卡片列表发懵。
 */

import type { Template, TemplateId } from '../../types';
import { TEMPLATE_LIST } from '../../resume/templates';
import { cx } from '../../lib/util';

export interface TemplatePickerProps {
  /** 当前模板 id（可能来自库里存的字符串，未必是登记过的 id） */
  value: TemplateId;
  /** 选中即生效（调用方负责写库 + 撤销点） */
  onChange: (id: TemplateId) => void;
}

/** 布局的中文名（3 个，不进 `types.ts`：这是展示文案，不是数据） */
const LAYOUT_LABEL: Record<Template['layout'], string> = {
  single: '单栏',
  double: '双栏',
  timeline: '时间轴',
};

export function TemplatePicker({ value, onChange }: TemplatePickerProps) {
  const known = TEMPLATE_LIST.some((item) => item.id === value);

  return (
    <div className="tpl-picker" role="radiogroup" aria-label="选择简历模板">
      {TEMPLATE_LIST.map((template) => {
        const active = template.id === value;
        return (
          <button
            type="button"
            key={template.id}
            role="radio"
            aria-checked={active}
            aria-label={`${template.name}（${LAYOUT_LABEL[template.layout]}）：${template.targetDirection}`}
            className={cx('tpl-card', active && 'tpl-card--on')}
            onClick={() => onChange(template.id)}
          >
            {/*
              缩略图是本仓构建期常量（thumbs.ts 生成的 SVG 字符串，无外链、无用户数据），
              不是可注入内容 —— 所以这里用 dangerouslySetInnerHTML 是安全的。
              换成 `src` 指向 SVG 文件会让单文件产物多出一次 file:// 请求，破零网络承诺。
            */}
            <span
              className="tpl-card__thumb"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: template.thumbnail }}
            />
            <span className="tpl-card__name">{template.name}</span>
            <span className="tpl-card__dir">{template.targetDirection}</span>
            <span className="tpl-card__layout">{LAYOUT_LABEL[template.layout]}</span>
          </button>
        );
      })}

      {known ? null : (
        <p className="tpl-picker__warn" role="status">
          当前模板未登记，已回落到通用表单 —— 选一张卡片即可换回来
        </p>
      )}
    </div>
  );
}
