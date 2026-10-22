/**
 * 插件 iframe 沙箱（v0.8 / T04，ARCH §1.3）。
 *
 * 双层防线：
 * 1. **iframe 属性层**：`sandbox="allow-scripts"` 且**绝不**给 allow-same-origin
 *    —— 插件拿到的是 opaque origin，读不到宿主 localStorage/DOM/cookie。
 * 2. **CSP 层**：宿主统一往插件 html 注入 `connect-src 'none'` 的 CSP meta，
 *    即使插件包自带放宽的 CSP 也被剥掉重写（D16 第 2 类：iframe 内 fetch 必须被拦）。
 *
 * CSP 字段取舍：default-src 'none' 全封底；script/style 只开 inline（插件
 * 的代码全部内联在单 html 里，这是插件包形态的本意）；img 只开 data:；
 * connect-src 'none' 是零网络承诺在插件侧的落点。
 */

export const SANDBOX_ATTRS = 'allow-scripts';

export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'";

const CSP_META_RE = /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi;
const HEAD_RE = /<head[^>]*>/i;

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;

/**
 * 插件 html → iframe srcdoc 内容。
 * 自带 CSP meta 一律剥掉（插件不得放宽网络策略），换成宿主统一的这份。
 */
export function buildPluginSrcDoc(html: string): string {
  const stripped = html.replace(CSP_META_RE, '');
  if (HEAD_RE.test(stripped)) {
    return stripped.replace(HEAD_RE, (head) => `${head}${CSP_META}`);
  }
  return `${CSP_META}${stripped}`;
}
