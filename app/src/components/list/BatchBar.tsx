/**
 * 模块四 · 批量操作条（SIL-3 / SIL-4 / SIL-5）。
 *
 * 三个动作，三种「敢不敢一步做完」的答案：
 * - **放弃**：一步写 N 条状态，但入栈一个 `multiStatus` 撤销（一次 ⌘Z 整批退回）——
 *   所以第一次点只是「上膛」，第二次点才真的写；
 * - **静音**：不入撤销栈（再点一次就能取消静音，本身就是可逆的），但**明说静音不动记录**；
 * - **催问话术**：生成话术 ≠ 发了消息。只有用户勾了「已发出」的那几条才写 followup note
 *   （`planBatchFollowup`）—— 一步到位会把没发的记录全刷成绿色，那是在骗自己。
 */

import { useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { SilenceRow } from '../../lib/silence/list';
import { muteLabelOf, planBatchFollowup, planBatchMute } from '../../lib/silence/list';
import { buildFollowupScript } from '../../lib/rules';
import { copyText, cx } from '../../lib/util';
import { CLS } from '../../lib/classTokens';

/** 静音预设：'3d' / 'nextWeek'（下周同一天 23:59:59，不是「7×24 小时后」） */
const MUTE_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '3d', label: '静音 3 天' },
  { value: 'nextWeek', label: '静音到下周' },
];

export interface BatchBarProps {
  api: AppApi;
  /** 当前勾选的行（顺序即清单顺序，撤销顺序也照它来） */
  rows: SilenceRow[];
  onClear: () => void;
}

export function BatchBar({ api, rows, onClear }: BatchBarProps) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const [sentIds, setSentIds] = useState<string[]>([]);
  const [dropArmed, setDropArmed] = useState(false);
  const [muteDate, setMuteDate] = useState('');

  if (rows.length === 0) return null;

  const ids = rows.map((row) => row.app.id);
  const sent = planBatchFollowup(ids, sentIds);

  const companyOf = (row: SilenceRow): string =>
    row.company ? row.company.shortName || row.company.name : '';

  const muteTo = (preset: string): void => {
    const [first] = planBatchMute(ids, preset, api.now);
    if (!first) return;
    api.silence.batchMute(ids, first.mutedUntil);
    api.toast(`已静音 ${ids.length} 条 · ${muteLabelOf(first.mutedUntil)}`);
    onClear();
  };

  const drop = (): void => {
    if (!dropArmed) {
      setDropArmed(true);
      return;
    }
    // 这一句 toast 由 App 发：只有它手里有撤销栈，能把「撤销」按钮直接塞进提示里。
    // 组件再补一句只会把那个按钮盖掉，用户就只剩「记住 ⌘Z」这一条路了。
    api.silence.batchDrop(ids);
    setDropArmed(false);
    onClear();
  };

  const recordFollowups = (): void => {
    const written = api.silence.batchFollowup(ids, sentIds);
    api.toast(written > 0 ? `记下 ${written} 条跟进` : '还没勾「已发出」，一条都没记');
    setScriptOpen(false);
    setSentIds([]);
    if (written > 0) onClear();
  };

  const copyScript = async (text: string): Promise<void> => {
    const ok = await copyText(text);
    api.toast(ok ? '话术已复制' : '复制失败，请手动选中');
  };

  return (
    <div className="sil-bar" data-testid="sil-batch">
      <div className="sil-bar__row">
        <span className="sil-bar__count">已选 {rows.length} 条</span>
        <button type="button" className={CLS.b} onClick={onClear}>
          取消选择
        </button>
        <button
          type="button"
          className={CLS.b}
          data-testid="sil-script-open"
          onClick={() => {
            setScriptOpen(!scriptOpen);
            setSentIds([]);
          }}
        >
          {scriptOpen ? '收起话术' : '生成催问话术'}
        </button>
        <span className="sil-bar__mute">
          <span className="sil-bar__mute-label">静音</span>
          {MUTE_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className={CLS.h}
              data-testid={`sil-mute-${preset.value}`}
              onClick={() => muteTo(preset.value)}
            >
              {preset.label}
            </button>
          ))}
          <input
            type="date"
            className={CLS.G}
            value={muteDate}
            aria-label="静音到哪天"
            onChange={(event) => setMuteDate(event.target.value)}
          />
          <button
            type="button"
            className={CLS.h}
            disabled={!muteDate}
            data-testid="sil-mute-date"
            onClick={() => muteTo(muteDate)}
          >
            静到这个日期
          </button>
        </span>
        <button
          type="button"
          className={cx(CLS.b, 'sil-bar__danger')}
          data-testid="sil-drop"
          onClick={drop}
        >
          {dropArmed ? `真的放弃这 ${rows.length} 条` : '标为已放弃'}
        </button>
      </div>

      <p className={CLS.c}>
        静音只是「这段时间别再提它」，记录、状态、时间线一个字都不动；到期自己回到清单。
      </p>

      {dropArmed ? (
        <p className={CLS.s}>
          放弃会改状态并写一条记录 —— 点上面那个按钮才生效，或者点「取消选择」反悔。
        </p>
      ) : null}

      {scriptOpen ? (
        <div className="sil-scripts" data-testid="sil-scripts">
          <p className={CLS.c}>
            话术是按沉默天数和状态备好的字 —— <strong>发出去了才算跟进</strong>
            ，只有勾了「已发出」的才会记进时间线。
          </p>
          {rows.map((row) => {
            const text = buildFollowupScript(row.app, companyOf(row), row.silence.days);
            const checked = sentIds.includes(row.app.id);
            return (
              <div key={row.app.id} className="sil-script">
                <label className="sil-script__head">
                  <input
                    type="checkbox"
                    checked={checked}
                    data-testid={`sil-sent-${row.app.id}`}
                    onChange={() =>
                      setSentIds((prev) =>
                        prev.includes(row.app.id)
                          ? prev.filter((id) => id !== row.app.id)
                          : [...prev, row.app.id],
                      )
                    }
                  />
                  <span>
                    {companyOf(row) || '未知公司'} · {row.app.jobTitle}（{row.silence.text}）
                  </span>
                </label>
                <textarea
                  className={cx(CLS.T, 'sil-script__text')}
                  value={text}
                  readOnly
                  rows={3}
                  aria-label={`给 ${companyOf(row) || '未知公司'} 的话术`}
                />
                <button type="button" className={CLS.h} onClick={() => void copyScript(text)}>
                  复制这段话
                </button>
              </div>
            );
          })}
          <div className={CLS.r}>
            <button
              type="button"
              className={CLS.af}
              disabled={sent.length === 0}
              data-testid="sil-record-followup"
              onClick={recordFollowups}
            >
              记下已发出的 {sent.length} 条
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
