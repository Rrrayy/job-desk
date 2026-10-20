/**
 * 采集通道：把「用户给我的东西」统一成 AdapterInput。
 *
 * 三条通道共用这一层（架构 D-03）：
 * ① 粘贴（Ctrl+A/C/V）② 拖入 .json 文件 ③ 浏览器扩展写入剪贴板的 JSON 信封
 * 三者最终都变成 `{ url?, title?, text, capturedAt }`，然后走同一个适配器。
 */

import type { PlatformId } from '../../types';
import type { SyncAdapter } from '../../adapters/types';
import { ADAPTERS, adapterById, adapterForUrl, isAdapterStale } from '../../adapters/registry';

/** 扩展信封的 format 字段；不认识就当裸文本 */
export const ENVELOPE_FORMAT = 'job-desk/capture@1';

export interface CaptureEnvelope {
  format: string;
  url?: string;
  title?: string;
  capturedAt: string;
  text: string;
}

export type CaptureKind = 'envelope' | 'raw-text' | 'backup-json' | 'empty';

export interface CapturePayload {
  kind: CaptureKind;
  /** 真正要喂给适配器的纯文本 */
  text: string;
  url?: string;
  title?: string;
  capturedAt: string;
  /** 给用户看的一句话：这条内容是从哪来的 */
  sourceLabel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 识别剪贴板/文件内容的形态。**永不 throw** */
export function detectCapture(raw: string, nowIso: string): CapturePayload {
  const text = raw ?? '';
  if (!text.trim()) {
    return { kind: 'empty', text: '', capturedAt: nowIso, sourceLabel: '空内容' };
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed.text === 'string') {
        const format = typeof parsed.format === 'string' ? parsed.format : ENVELOPE_FORMAT;
        return {
          kind: 'envelope',
          text: parsed.text,
          url: typeof parsed.url === 'string' ? parsed.url : undefined,
          title: typeof parsed.title === 'string' ? parsed.title : undefined,
          capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : nowIso,
          sourceLabel: `扩展抓取${typeof parsed.title === 'string' ? `：${parsed.title}` : ''}（${format}）`,
        };
      }
      if (isRecord(parsed) && Array.isArray(parsed.applications)) {
        return {
          kind: 'backup-json',
          text: trimmed,
          capturedAt: nowIso,
          sourceLabel: '这是一份数据备份，不是平台页面；同步面板不处理备份文件',
        };
      }
    } catch {
      // 解析失败 → 当裸文本处理，交给适配器自己的启发式
    }
  }

  return { kind: 'raw-text', text, capturedAt: nowIso, sourceLabel: '粘贴的页面文本' };
}

export interface PickedAdapter {
  adapter: SyncAdapter;
  /** 命中依据，写进 UI 的「来源」一行 */
  source: 'url' | 'platform' | 'guess' | 'fallback';
  stale: boolean;
  /** 识别不到平台时给用户的提示 */
  hint?: string;
}

/** 文本里的平台指纹（粘贴通道没有 URL，只能靠关键词猜） */
function guessPlatformByText(text: string): PlatformId | null {
  const head = text.slice(0, 5000);
  if (/BOSS直聘|boss直聘|zhipin|沟通中|已投递/.test(head)) return 'boss';
  if (/实习僧|shixiseng/.test(head)) return 'shixiseng';
  if (/牛客|nowcoder/.test(head)) return 'nowcoder';
  return null;
}

/**
 * 选适配器。优先级：URL 命中 > 用户手选的平台 > 文本指纹 > custom 兜底。
 * 选不到时也**不报错**，用 custom 试一下（它是最后一层保险）。
 */
export function pickAdapter(
  payload: CapturePayload,
  platform: PlatformId | undefined,
  nowIso: string,
): PickedAdapter {
  const byUrl = adapterForUrl(payload.url);
  if (byUrl) {
    return { adapter: byUrl, source: 'url', stale: isAdapterStale(byUrl, nowIso) };
  }
  if (platform) {
    const byId = adapterById(platform);
    if (byId) return { adapter: byId, source: 'platform', stale: isAdapterStale(byId, nowIso) };
  }
  const guessed = guessPlatformByText(payload.text);
  if (guessed) {
    const adapter = adapterById(guessed);
    if (adapter) return { adapter, source: 'guess', stale: isAdapterStale(adapter, nowIso) };
  }
  const fallback = adapterById('custom') ?? ADAPTERS[ADAPTERS.length - 1];
  return {
    adapter: fallback,
    source: 'fallback',
    stale: isAdapterStale(fallback, nowIso),
    hint: '没识别出是哪个平台的页面，已按「通用表格」试解析；如果一条都没认出来，请确认复制的是投递/沟通列表页',
  };
}

/** 统一的 AdapterInput 构造 */
export function toAdapterInput(payload: CapturePayload): {
  url?: string;
  title?: string;
  text: string;
  capturedAt: string;
} {
  return {
    url: payload.url,
    title: payload.title,
    text: payload.text,
    capturedAt: payload.capturedAt,
  };
}

/** 文件通道：读成文本（FileReader，纯本地，无网络） */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败，请确认文件没有损坏'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file, 'utf-8');
  });
}

/** 文件大小上限：2 MB（一份页面文本不可能更大；防止用户误拖整份备份） */
export const MAX_CAPTURE_FILE_BYTES = 2 * 1024 * 1024;
