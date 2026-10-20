/** 顶部轻 toast：状态变更后 5 秒内可撤销。 */

export interface ToastState {
  id: number;
  text: string;
  undo?: (() => void) | null;
}

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div className="toast" key={toast.id} role="status">
      <span className="toast__text">{toast.text}</span>
      {toast.undo ? (
        <button type="button" className="toast__undo" onClick={toast.undo}>
          撤销
        </button>
      ) : null}
      <button type="button" className="toast__close" onClick={onClose} aria-label="关闭提示">
        ✕
      </button>
    </div>
  );
}
