/**
 * 打印入口 + 提示层（PRD §9-4）。
 *
 * 为什么先弹一层提示再打印：浏览器打印对话框里「缩放 / 页边距 / 适应页面」三个开关
 * 一动，分页就会错乱，而用户第一次打开时根本不知道该怎么选。提示层只说两件事：
 * 选「另存为 PDF」、缩放选默认或 100%。
 *
 * 把它做成独立组件而不是塞进简历页：T05 的 ResumeEditor 在工具条上挂一个
 * `<PrintButton onBeforePrint={flush} />` 就完事，不用再抄一遍提示文案。
 * 副作用编排全在 `resume/print.ts`，这里只管按钮、对话框与焦点。
 *
 * A11y（ARCH §7.5）：`role="dialog"` + `aria-modal`，打开时焦点落「继续打印」，
 * `Esc` 关闭并**把焦点还给打印按钮**（否则键盘用户会掉到页面顶部）。
 */

import { useEffect, useRef, useState } from 'react';
import { PRINT_HINT_LINES, printResume } from '../../resume/print';

export interface PrintButtonProps {
  /** 打印前 flush 草稿（T05 传 useResumeDraft 的 flush） */
  onBeforePrint?: () => void;
  label?: string;
}

export function PrintButton({ onBeforePrint, label = '打印 / 存为 PDF' }: PrintButtonProps) {
  const [hintOpen, setHintOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!hintOpen) return;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setHintOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hintOpen]);

  const closeHint = (): void => {
    setHintOpen(false);
    triggerRef.current?.focus();
  };

  const run = (): void => {
    setHintOpen(false);
    setError(null);
    const result = printResume({ flush: onBeforePrint });
    if (!result.ok) setError(result.reason);
  };

  return (
    <div className="print-entry">
      <button
        type="button"
        className="btn"
        ref={triggerRef}
        onClick={() => {
          setError(null);
          setHintOpen(true);
        }}
      >
        {label}
      </button>
      {error ? <span className="field__hint field__hint--danger">{error}</span> : null}

      {hintOpen ? (
        <div className="overlay" role="presentation" onClick={closeHint}>
          <div
            className="modal print-hint"
            role="dialog"
            aria-modal="true"
            aria-labelledby="print-hint-title"
            // 点卡片内部不该关掉对话框
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="print-hint__title" id="print-hint-title">
              打印小提示
            </h2>
            <ul className="print-hint__list">
              {PRINT_HINT_LINES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="print-hint__acts">
              <button type="button" className="btn" onClick={closeHint}>
                取消
              </button>
              <button type="button" className="btn btn--primary" ref={confirmRef} onClick={run}>
                继续打印
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
