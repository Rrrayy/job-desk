/**
 * D13 发送预览弹层（v0.8 / T03）—— 一切 AI 请求的**强制**最后一道闸门。
 *
 * 铁律：
 * 1. 任何 AI 请求（内置场景 / 插件 ai_request）在发送前必须先过这里，
 *    没有绕过路径，没有「记住我的选择」。确认一次只授权一次发送。
 * 2. 默认勾选 = `companyName / jobTitle / status` ∪ 锁定字段。
 *    所有**新增**出境字段（轮次 / 面试类型 / 笔试结果 / 面经原文 / 沟通记录）
 *    默认不勾 —— 这是 PRD 验收 8 的基线，快照测试盯着，改基线必须改测试。
 * 3. 锁定字段（如 D17 的用户粘贴原文）必须发送，勾选框禁用并标注。
 * 4. 明示去向：模型名 + 完整端点；isLocal 时追加「本机端口，不出公网」。
 *
 * 组件只负责「让用户看清并勾选」，不做任何网络动作 —— 确认后把勾选字段
 * 交给调用方，由调用方走 gateway（唯一 fetch 点）+ RequestLog。
 */

import { useState } from 'react';
import type { PreviewField } from '../../ai/types';

/** 默认勾选基线（PRD 验收 8）。改动这里必须同步 SendPreviewDialog.test.tsx 的基线断言 */
export const SEND_PREVIEW_DEFAULT_CHECKED: ReadonlySet<string> = new Set([
  'companyName',
  'jobTitle',
  'status',
]);

function initialChecked(fields: PreviewField[]): Set<string> {
  const checked = new Set<string>();
  for (const field of fields) {
    if (field.locked || SEND_PREVIEW_DEFAULT_CHECKED.has(field.name)) checked.add(field.name);
  }
  return checked;
}

export interface SendPreviewDialogProps {
  /** 弹层标题（场景名，如「AI 补全暂存行」） */
  title: string;
  /** 发起方 id（builtin:d14 / 插件 id），展示用 */
  pluginId: string;
  baseURL: string;
  model: string;
  /** 本机端点（127.0.0.1/localhost）→ 明示「不出公网」 */
  isLocal: boolean;
  fields: PreviewField[];
  /** 确认发送：参数 = 勾选字段 {name: value}（锁定字段恒在） */
  onConfirm: (checked: Record<string, string>) => void;
  onCancel: () => void;
}

export function SendPreviewDialog(props: SendPreviewDialogProps): JSX.Element {
  const { title, pluginId, baseURL, model, isLocal, fields, onConfirm, onCancel } = props;
  const [checked, setChecked] = useState<Set<string>>(() => initialChecked(fields));

  const toggle = (name: string, next: boolean): void => {
    setChecked((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(name);
      else copy.delete(name);
      return copy;
    });
  };

  const confirm = (): void => {
    const payload: Record<string, string> = {};
    for (const field of fields) {
      if (checked.has(field.name)) payload[field.name] = field.value;
    }
    onConfirm(payload);
  };

  const selectedCount = fields.filter((field) => checked.has(field.name)).length;

  return (
    <div className="overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="send-preview"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal__body">
          <p className="field__hint" data-testid="send-preview-meta">
            模型 <strong>{model || '（未配置）'}</strong> @ <code>{baseURL || '（未配置）'}</code>
            {isLocal ? ' · 本机端口，请求不出公网' : ''}
          </p>
          <p className="field__hint">
            下方是这次请求会带上的内容。**只勾选你愿意发给这个模型的字段**；
            取消则什么都不发送。本次确认只对这一次发送生效。
          </p>
          <div data-testid="send-preview-fields">
            {fields.map((field) => {
              const isChecked = field.locked || checked.has(field.name);
              return (
                <label key={field.name} className="field" data-testid={`preview-field-${field.name}`}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={field.locked === true}
                    onChange={(event) => toggle(field.name, event.target.checked)}
                  />
                  <span className="field__label">
                    {field.label}
                    {field.locked ? '（必发）' : ''}
                  </span>
                  <span className="field__hint">{field.value || '（空）'}</span>
                </label>
              );
            })}
          </div>
          {selectedCount === 0 ? (
            <p className="field__hint field__hint--danger">没有勾选任何字段 —— 空请求没有意义，发送按钮已禁用。</p>
          ) : null}
        </div>
        <footer className="modal__foot">
          <span className="field__hint">
            发起方 <code>{pluginId}</code> · 已选 {selectedCount} / {fields.length} 项
          </span>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="send-preview-confirm"
            onClick={confirm}
            disabled={selectedCount === 0}
          >
            发送（{selectedCount} 项）
          </button>
        </footer>
      </div>
    </div>
  );
}
