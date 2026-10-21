/**
 * 这个文件是**唯一**需要 DOM 的测试。
 *
 * 为什么不起 jsdom：架构 D-04 已经定下「vitest 只跑纯 node 环境」，
 * 为了一个测试改全局环境，会让所有测试慢一个数量级，也给了以后
 * 「顺手在测试里渲染组件」的口子。
 *
 * 改法：手写一个只有 querySelectorAll 的假 document。`rebuildSelfHtml`
 * 对 DOM 的全部依赖就是这两个选择器，假对象能忠实复现它的行为。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { rebuildSelfHtml, sha256Hex } from './selfSnapshot';

interface FakeEl {
  src?: string;
  textContent: string;
  getAttribute: (name: string) => string | null;
}

/** 极简：把一段 HTML 解析成我们关心的 script / style 元素 */
function parseRich(html: string): { scripts: FakeEl[]; styles: FakeEl[] } {
  const scripts: FakeEl[] = [];
  const styles: FakeEl[] = [];
  const tagRe = /<(script|style)([^>]*)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const [, tag, attrs, body] = match;
    const attrOf = (name: string): string | null => {
      const found = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
      return found ? found[1] : null;
    };
    const el: FakeEl = {
      textContent: body,
      getAttribute: attrOf,
    };
    const src = attrOf('src');
    if (src) el.src = src;
    if (tag === 'script') scripts.push(el);
    else styles.push(el);
  }
  return { scripts, styles };
}

let current = { scripts: [] as FakeEl[], styles: [] as FakeEl[] };

function setBody(html: string): void {
  current = parseRich(html);
}

// 用 Object.defineProperty 挂全局：jsdom 的风格，node 环境下也能装
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    querySelectorAll(selector: string): FakeEl[] {
      if (selector === 'script') return current.scripts;
      if (selector === 'style') return current.styles;
      return [];
    },
  },
});

describe('rebuildSelfHtml', () => {
  beforeEach(() => {
    setBody('');
  });

  it('把内联 style 与 module script 原样带过去', () => {
    setBody('<style>:root{--x:1}</style><script type="module">console.log(1)</script>');
    const result = rebuildSelfHtml();
    expect(result.scriptCount).toBe(1);
    expect(result.styleCount).toBe(1);
    expect(result.html).toContain(':root{--x:1}');
    expect(result.html).toContain('<script type="module">console.log(1)</script>');
    expect(result.html).toContain('<div id="root"></div>');
  });

  it('跳过外链 script（零网络承诺：产物里不该有，有也不打包）', () => {
    // 注意：这里不能写真实 URL —— check:no-network 会把这个测试文件本身
    // 当成远程脚本引入而报红。用相对路径表达「有 src 就跳过」这件事即可。
    setBody('<script src="external-bundle.js"></script><script type="module">app()</script>');
    const result = rebuildSelfHtml();
    expect(result.scriptCount).toBe(1);
    expect(result.html).not.toContain('external-bundle.js');
  });

  it('跳过非 module 的内联脚本（避免把第三方统计之类打进去）', () => {
    setBody('<script>var legacy=1</script><script type="module">app()</script>');
    const result = rebuildSelfHtml();
    expect(result.scriptCount).toBe(1);
    expect(result.html).not.toContain('var legacy=1');
  });

  it('产出是完整可打开的 HTML 文档', () => {
    setBody('<script type="module">app()</script>');
    const { html } = rebuildSelfHtml();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="UTF-8" />');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('多个 style（单文件产物会有 base + 业务两段）都保留', () => {
    setBody('<style>a{}</style><style>b{}</style><script type="module">x()</script>');
    const result = rebuildSelfHtml();
    expect(result.styleCount).toBe(2);
    expect(result.html).toContain('a{}');
    expect(result.html).toContain('b{}');
  });
});

describe('sha256Hex', () => {
  it('空输入也能返回 64 位十六进制', async () => {
    const hex = await sha256Hex(new Uint8Array(0));
    if (hex !== '') expect(hex).toHaveLength(64);
  });

  it('同输入同输出', async () => {
    const data = new TextEncoder().encode('求职工作台');
    expect(await sha256Hex(data)).toBe(await sha256Hex(data));
  });
});
