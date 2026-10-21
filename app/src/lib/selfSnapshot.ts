/**
 * 从当前页面「捞回自己」（v0.5 / D5 便携包）。
 *
 * 为什么不去 fetch(location.href)：
 *   - `file://` 下 fetch 被同源策略拦死，而这正是本项目的主场景；
 *   - dev server 下取回的是未构建的 HTML，打出来的包打不开。
 *
 * 所以改成**从 DOM 重建**：把内联的 <style> 与 <script> 的文本原样取出来，
 * 套回一份干净的 HTML 骨架。只要构建产物是「单文件、无外链」（这是
 * `vite-plugin-singlefile` + check:no-network 已经保证的事），重建就是无损的。
 */

/** 产物里唯一的那个 module script 的内容 */
function collectInlineScripts(): string[] {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll('script'))) {
    // 外链脚本不该存在（零网络承诺），出现了就跳过而不是塞个空标签
    if (el.src) continue;
    const type = el.getAttribute('type');
    if (type !== 'module') continue; // 只取应用主 bundle，跳过多余的内联小脚本
    out.push(el.textContent ?? '');
  }
  return out;
}

function collectInlineStyles(): string[] {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll('style'))) {
    out.push(el.textContent ?? '');
  }
  return out;
}

export interface SnapshotResult {
  html: string;
  /** 重建出的 script 数量，用于自检（不是 1 就说明构建方式变了） */
  scriptCount: number;
  styleCount: number;
}

/**
 * 重建一份「可独立双击打开」的 HTML。
 *
 * 注意：这里产出的 HTML 与 `dist/index.html` **不是逐字节相同**（
 * vite 的注释、preload 提示会丢），但功能等价 —— 便携包不需要可复现哈希，
 * 需要的是「双击能用」。真正的可复现产物是 `scripts/pack-release.mjs` 出的发布包。
 */
export function rebuildSelfHtml(): SnapshotResult {
  const scripts = collectInlineScripts();
  const styles = collectInlineStyles();

  const html = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '    <meta name="color-scheme" content="light dark" />',
    '    <title>求职工作台</title>',
    ...styles.map((css) => `    <style>${css}</style>`),
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    ...scripts.map((js) => `    <script type="module">${js}</script>`),
    '  </body>',
    '</html>',
    '',
  ].join('\n');

  return { html, scriptCount: scripts.length, styleCount: styles.length };
}

/** SHA-256（hex）。非安全上下文（file:// 的某些老浏览器）下退化为空串，不阻塞导出 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    if (!globalThis.crypto || !globalThis.crypto.subtle) return '';
    // 需要一份独立的 ArrayBuffer（subtle.digest 不接受 SharedArrayBuffer 视图）
    const copy = bytes.slice().buffer;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}
