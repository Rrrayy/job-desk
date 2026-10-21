/**
 * CSV / 手抄清单导入预览（v0.6 / P1）。
 *
 * 这个对话框是「自动映射」这个功能的**信任来源**。
 * 自动映射一定会有猜错的时候，用户凭什么敢点确认？凭这份预览：
 * - 每一列映射到了哪个字段（以及哪几列被忽略、为什么）
 * - 前 8 行长什么样（足够判断映射对不对）
 * - 哪些行被跳过、哪些值被替换成默认值、为什么
 *
 * 所以布局顺序是「结论 → 证据 → 动作」，而不是把表格塞满整屏。
 */

import { useState } from 'react';
import type { MappingPreview } from '../lib/csvImport';
import { STATUS_LABEL } from '../lib/rules';

export interface CsvImportDialogProps {
  fileName: string;
  preview: MappingPreview;
  /** 库里已有的投递数（用于说明「会合进现有数据」而不是覆盖） */
  existingCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 前 N 行的表格预览：再多用户也不会逐行核对，只会看个开头 */
const PREVIEW_ROWS = 8;

export function CsvImportDialog(props: CsvImportDialogProps) {
  const { preview } = props;
  const [showIssues, setShowIssues] = useState(false);
  const mapped = preview.columns.filter((column) => column.field !== null);
  const rows = preview.rows.slice(0, PREVIEW_ROWS);

  return (
    <div className="overlay" onClick={props.onCancel}>
      <div
        className="modal modal--csv"
        role="dialog"
        aria-modal="true"
        aria-label="确认字段映射"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">确认字段映射</h2>
          <button type="button" className="icon-btn" onClick={props.onCancel} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="modal__body">
          <p className="field__hint">
            <code>{props.fileName}</code> 里识别到 <strong>{preview.rows.length}</strong> 条投递、
            <strong>{mapped.length}</strong> 列有对应字段。确认后会**合并**进现有的 {props.existingCount}{' '}
            条投递里（同公司 + 同岗位 + 同投递日算重复，不会重复插入）。
          </p>

          <h3 className="drawer__section-title">列 → 字段</h3>
          <div className="mapping-chips">
            {mapped.map((column) => (
              <span key={`${column.header}-${column.field}`} className="mapping-chip">
                <span className="mapping-chip__from">{column.header}</span>
                <span className="mapping-chip__arrow">→</span>
                <span className="mapping-chip__to">{FIELD_LABEL[column.field ?? 'company'] ?? column.field}</span>
              </span>
            ))}
            {preview.unmapped.map((column) => (
              <span key={column.header} className="mapping-chip mapping-chip--off" title={column.reason}>
                <span className="mapping-chip__from">{column.header}</span>
                <span className="mapping-chip__arrow">×</span>
                <span className="mapping-chip__to">忽略</span>
              </span>
            ))}
          </div>

          {preview.unmapped.length > 0 ? (
            <p className="field__hint">
              灰色的列没有被导入：表头认不出来。想带上它们，把表头改成「备注」「城市」这类常见写法再导一次。
            </p>
          ) : null}

          <h3 className="drawer__section-title">前 {rows.length} 行预览</h3>
          <div className="preview-table-wrap">
            <table className="table preview-table">
              <thead>
                <tr>
                  <th>公司</th>
                  <th>岗位</th>
                  <th>状态</th>
                  <th>投递日</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    <td>{row.company}</td>
                    <td>{row.jobTitle || <span className="muted">（空）</span>}</td>
                    <td>{STATUS_LABEL[row.status]}</td>
                    <td className="mono">{row.appliedAt}</td>
                    <td className="preview-table__note">{row.notes || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.rowIssues.length > 0 ? (
            <div className="notice notice--warn">
              <strong>
                有 {preview.rowIssues.length} 条需要注意{preview.skipped > 0 ? `，其中 ${preview.skipped} 行已跳过` : ''}
              </strong>
              <button type="button" className="link-btn" onClick={() => setShowIssues((value) => !value)}>
                {showIssues ? '收起' : '展开看看'}
              </button>
              {showIssues ? (
                <ul className="issue-list">
                  {preview.rowIssues.map((issue, index) => (
                    <li key={index}>
                      第 {issue.row} 行：{issue.reason}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="field__hint">
                  展开后能看到每一行具体哪里不对。被跳过的行不会写进库，被替换的值会按默认值写入。
                </p>
              )}
            </div>
          ) : null}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={props.onConfirm}
            disabled={preview.rows.length === 0}
          >
            导入 {preview.rows.length} 条
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 字段的中文名（与别名表分开：这里是展示用，别名是识别用） */
const FIELD_LABEL: Record<string, string> = {
  company: '公司',
  jobTitle: '岗位',
  status: '状态',
  channel: '渠道',
  appliedAt: '投递日',
  lastContactAt: '最近联系',
  city: '城市',
  salary: '薪资',
  link: '链接',
  resumeVersion: '简历版本',
  priority: '优先级',
  notes: '备注',
  note: '备注',
};
