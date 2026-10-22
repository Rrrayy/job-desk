/**
 * 通用表单渲染器（ARCH §1.6）：**schema 驱动，不按模板写 8 套表单**。
 *
 * 渲染规则（一句话）：按模板的板块顺序 → 每个板块一个可改名的标题 → 板块内按
 * 条目（repeatable 时可增删移序）→ 每个条目内按字段顺序渲染控件。
 *
 * 三条刻意的边界：
 * 1. **受控组件**：它不持有整份 `ResumeContent`，只接收 `content` + `onChange`。
 *    草稿与防抖落库归 `useResumeDraft`（T05 的 ResumeEditor 持有），
 *    这样「AI 写回前 flush」「打印前 flush」这些都是调用方一句话的事，
 *    而不是把计时器埋进一个渲染器里谁也调不动。
 * 2. **必填留空不阻止保存**（PRD §8.3）：`required` 只渲染一行浅色「未填」，
 *    不 disable 任何按钮、不弹错。简历本来就会有一段时间是半成品。
 * 3. **字段控件的 key 一律用 `field.key`**：同一条目里两个字段换位置时，
 *    用下标当 key 会让输入框在换序后串值（一次真实的 bug 来源）。
 */

import type { ResumeContent, ResumeItem, TemplateFieldSpec, TemplateSectionSpec } from '../../types';
import { cleanBullets, addItem, fieldValueOf, moveItem, removeItem, setBullets, setField, setSectionTitle } from '../../resume/schema';
import { SECTION_LABEL, fieldMetaOf } from '../../resume/templates/base';
import { Field } from '../Field';
import { BulletsField } from './BulletsField';
import { PhotoField } from './PhotoField';
import { TagsField } from './TagsField';

export interface SchemaFormProps {
  /** 当前模板的板块定义（由 `sectionsOf(templateId)` 给） */
  sections: TemplateSectionSpec[];
  /** 当前草稿 */
  content: ResumeContent;
  /** 任何一处改动 → 新的整份内容（不可变） */
  onChange: (next: ResumeContent) => void;
}

export function SchemaForm(props: SchemaFormProps) {
  const { sections, content, onChange } = props;

  return (
    <form
      className="resume__form resume-form"
      onSubmit={(event) => {
        // 表单里没有 submit 语义：回车在 Field 里就是「提交这一格」，别整页刷新
        event.preventDefault();
      }}
    >
      {sections.map((spec) => {
        // 没被 ensureSections 补出来就跳过（调用方负责补；这里不偷偷建，避免渲染期写数据）
        const section = content.sections.find((item) => item.type === spec.type);
        if (!section) return null;
        const fallbackLabel = spec.label ?? SECTION_LABEL[spec.type];

        return (
          <section className="resume-form__section" key={section.id}>
            <header className="resume-form__head">
              <input
                className="input input--compact resume-form__title"
                type="text"
                value={section.title ?? ''}
                placeholder={fallbackLabel}
                aria-label={`板块名：${fallbackLabel}`}
                onChange={(event) => onChange(setSectionTitle(content, section.id, event.target.value))}
              />
              <span className="resume-form__count">
                {spec.repeatable ? `${section.items.length} 条` : ''}
              </span>
            </header>

            {section.items.map((item, index) => (
              <div className="resume-form__item" key={item.id}>
                {spec.repeatable ? (
                  <div className="resume-form__item-head">
                    <span className="resume-form__item-index">
                      第 {index + 1} 条
                    </span>
                    <div className="resume-form__item-acts">
                      <button
                        type="button"
                        className="btn btn--tiny"
                        aria-label={`上移第 ${index + 1} 条`}
                        disabled={index === 0}
                        onClick={() => onChange(moveItem(content, section.id, item.id, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn--tiny"
                        aria-label={`下移第 ${index + 1} 条`}
                        disabled={index === section.items.length - 1}
                        onClick={() => onChange(moveItem(content, section.id, item.id, 1))}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn btn--tiny btn--danger-ghost"
                        aria-label={`删除第 ${index + 1} 条`}
                        onClick={() => onChange(removeItem(content, section.id, item.id))}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="resume-form__fields">
                  {spec.fields.map((field) => (
                    <FieldControl
                      key={field.key}
                      field={field}
                      item={item}
                      content={content}
                      sectionId={section.id}
                      onChange={onChange}
                    />
                  ))}
                </div>
              </div>
            ))}

            {spec.repeatable ? (
              <button
                type="button"
                className="btn btn--tiny resume-form__add"
                onClick={() => onChange(addItem(content, section.id))}
              >
                + 加一条{fallbackLabel}
              </button>
            ) : null}
          </section>
        );
      })}
    </form>
  );
}

interface FieldControlProps {
  field: TemplateFieldSpec;
  item: ResumeItem;
  content: ResumeContent;
  sectionId: string;
  onChange: (next: ResumeContent) => void;
}

/** 一个字段 → 一个控件。5 种类型里 2 种复用 `<Field>`，3 种是新组件（A-06）。 */
function FieldControl({ field, item, content, sectionId, onChange }: FieldControlProps) {
  const meta = fieldMetaOf(field);
  const write = (value: string): void => onChange(setField(content, sectionId, item.id, meta.key, value));

  if (meta.type === 'rich_bullets') {
    return (
      <div className="resume-form__field">
        <BulletsField
          label={meta.label}
          value={item.bullets ?? []}
          onChange={(bullets) => onChange(setBullets(content, sectionId, item.id, bullets))}
          placeholder={meta.placeholder}
          hint={meta.hint}
        />
        {meta.required && cleanBullets(item.bullets).length === 0 ? <Missing /> : null}
      </div>
    );
  }

  if (meta.type === 'tags') {
    return (
      <div className="resume-form__field">
        <TagsField
          label={meta.label}
          value={fieldValueOf(item, meta.key)}
          onChange={write}
          placeholder={meta.placeholder}
          hint={meta.hint}
        />
        {meta.required && fieldValueOf(item, meta.key).trim() === '' ? <Missing /> : null}
      </div>
    );
  }

  if (meta.type === 'image') {
    return (
      <div className="resume-form__field">
        <PhotoField label={meta.label} value={fieldValueOf(item, meta.key)} onChange={write} hint={meta.hint} />
      </div>
    );
  }

  // text / month：复用既有 <Field>（A-06），`live` 让预览不等失焦（验收 6）
  return (
    <div className="resume-form__field">
      <Field
        label={meta.label}
        type={meta.type}
        value={fieldValueOf(item, meta.key)}
        onCommit={write}
        placeholder={meta.placeholder}
        hint={meta.hint}
        live
        narrow={meta.type === 'month'}
      />
      {meta.required && fieldValueOf(item, meta.key).trim() === '' ? <Missing /> : null}
    </div>
  );
}

/** 必填未填的浅色提示（不阻止保存，PRD §8.3） */
function Missing() {
  return <span className="resume-form__missing">未填 · 留空也能保存</span>;
}
