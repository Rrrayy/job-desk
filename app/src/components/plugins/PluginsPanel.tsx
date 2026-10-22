/**
 * PluginsPanel（v0.8 / T04）：插件管理面板。
 *
 * 承载：加载插件包（单 html 文件）、启停、逐项授权、卸载、日志查看、
 * 以及已启用插件的沙箱 iframe（宿主唯一渲染插件代码的地方）。
 * 面板是纯编排：协议处理在 broker，存储在 plugins/storage，挂载点在设置页。
 */

import { useRef, useState } from 'react';
import { buildPluginSrcDoc } from '../../plugins/sandbox';
import type { PluginPermission, PluginRegistration } from '../../plugins/types';

export interface PluginsPanelProps {
  plugins: PluginRegistration[];
  onEnable: (pluginId: string, enabled: boolean) => void;
  onGrant: (pluginId: string, permission: PluginPermission, granted: boolean) => void;
  onUninstall: (pluginId: string) => void;
  onLoadFile: (file: File) => Promise<string | null>;
  requestLogs: Array<{ timestamp: string; pluginId: string; model: string; status: string; errorCode?: string }>;
}

function permissionLabel(permission: PluginPermission): string {
  if (permission === 'storage') return '键值存储（本插件命名空间）';
  if (permission.startsWith('network:')) return `AI 请求 · ${permission.slice(8)}（经预览确认后代理发送）`;
  return `AI 建议 · ${permission.slice(8)}（建议制，确认后才落库）`;
}

export function PluginsPanel(props: PluginsPanelProps): JSX.Element {
  const { plugins, onEnable, onGrant, onUninstall, onLoadFile, requestLogs } = props;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logPluginId, setLogPluginId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (file: File): Promise<void> => {
    const error = await onLoadFile(file);
    setLoadError(error);
    if (!error && fileRef.current) fileRef.current.value = '';
  };

  return (
    <div data-testid="plugins-panel">
      <p className="field__hint">
        插件是单个 html 文件，跑在无网络权限的沙箱 iframe 里；任何 AI 请求都要先过发送预览。
        加载后默认**不授予任何权限**，逐项授权后再启用。
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".html,.htm"
        data-testid="plugin-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void load(file);
        }}
      />
      {loadError ? (
        <p className="field__hint field__hint--danger" data-testid="plugin-load-error">
          {loadError}
        </p>
      ) : null}

      {plugins.length === 0 ? (
        <p className="field__hint" data-testid="plugins-empty">
          还没有安装插件。加载 app/plugins/notes-ai.plugin.html 体验示例。
        </p>
      ) : null}

      {plugins.map((plugin) => (
        <div key={plugin.pluginId} className="field" data-testid={`plugin-${plugin.pluginId}`}>
          <label>
            <input
              type="checkbox"
              checked={plugin.enabled}
              data-testid={`plugin-enable-${plugin.pluginId}`}
              onChange={(event) => onEnable(plugin.pluginId, event.target.checked)}
            />
            <strong>{plugin.name}</strong> <span className="field__hint">v{plugin.version} · {plugin.pluginId}</span>
          </label>
          <div className="drawer__actions">
            {plugin.permissions.map((permission) => (
              <label key={permission}>
                <input
                  type="checkbox"
                  checked={plugin.granted.includes(permission)}
                  data-testid={`plugin-perm-${plugin.pluginId}-${permission}`}
                  onChange={(event) => onGrant(plugin.pluginId, permission, event.target.checked)}
                />
                {permissionLabel(permission)}
              </label>
            ))}
          </div>
          <div className="drawer__actions">
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setLogPluginId(logPluginId === plugin.pluginId ? null : plugin.pluginId)}>
              {logPluginId === plugin.pluginId ? '收起日志' : '看请求日志'}
            </button>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => onUninstall(plugin.pluginId)}>
              卸载
            </button>
          </div>
          {logPluginId === plugin.pluginId ? (
            <div className="field__hint" data-testid={`plugin-logs-${plugin.pluginId}`}>
              {requestLogs.filter((log) => log.pluginId === plugin.pluginId).length === 0
                ? '暂无请求日志。'
                : requestLogs
                    .filter((log) => log.pluginId === plugin.pluginId)
                    .map((log) => (
                      <div key={`${log.timestamp}-${log.status}`}>
                        {log.timestamp.slice(0, 19).replace('T', ' ')} · {log.status}
                        {log.errorCode ? ` · ${log.errorCode}` : ''} · {log.model}
                      </div>
                    ))}
            </div>
          ) : null}
          {plugin.enabled
            ? null /* iframe 由 App 挂载（窗口引用要进 broker），面板只做管理 */
            : null}
        </div>
      ))}
    </div>
  );
}

/** 已启用插件的沙箱 iframe（宿主侧统一渲染点；窗口注册给 broker 校验来源） */
export function PluginFrame(props: {
  pluginId: string;
  html: string;
  name: string;
  registerWindow: (pluginId: string, win: Window | null) => void;
}): JSX.Element {
  return (
    <iframe
      title={props.name}
      sandbox="allow-scripts"
      srcDoc={buildPluginSrcDoc(props.html)}
      data-testid={`plugin-frame-${props.pluginId}`}
      onLoad={(event) => props.registerWindow(props.pluginId, (event.target as HTMLIFrameElement).contentWindow)}
    />
  );
}
