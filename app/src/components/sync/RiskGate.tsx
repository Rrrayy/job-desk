/**
 * 风险确认门（PRD §B.2 原文）。
 * 必须勾选才能进面板；`riskAckAt` 一旦有值永不再弹（设置页可查、可重置）。
 */

import { useState } from 'react';
import type { AppApi } from '../../lib/api';

export function RiskGate({ api }: { api: AppApi }) {
  const [checked, setChecked] = useState(false);

  return (
    <div className="sync__risk">
      <h3 className="sync__risk-title">⚠️ 请先读这段再开同步</h3>
      <p className="sync__risk-text">
        平台没有公开接口，我们做的是「读你自己屏幕上的内容」，不会替你登录、不会替你发请求、不会在后台跑。
        但<strong>这仍属于平台可能判定为「异常使用」的行为</strong>，理论上存在账号被限流或封禁的风险，
        <strong>风险由你自己承担</strong>。
      </p>
      <p className="sync__risk-text">
        建议只用自己的账号、投递量不大时偶尔同步（一天 1～2 次足够）。不接受这个风险，
        <strong>请继续用手动记录</strong> —— v0.1 的「3 秒记一家」一直可用。
      </p>
      <label className="sync__risk-check">
        <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        <span>我已了解风险，由我自行决定</span>
      </label>
      <div className="sync__risk-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!checked}
          onClick={() => api.ackSyncRisk()}
        >
          开始同步
        </button>
      </div>
      <p className="sync__risk-foot">
        数据全程在本地解析：不发任何网络请求，不上传任何内容。不接受可以在设置里重置这个确认。
      </p>
    </div>
  );
}
