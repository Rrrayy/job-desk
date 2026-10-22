/**
 * 零网络扫描器的单点结构测试（v0.8 / T03，ARCH §8-1 / T03 验收 ⑥）。
 *
 * 直接消费 check-no-network.mjs 导出的纯函数，不改磁盘、不发进程：
 * ① gateway.ts 的 fetch 只有在「单点豁免」下才放行，普通文件里的 fetch 必被抓；
 * ② gateway 内出现 fetch 之外的网络 API（第二个口子）→ 专项审计必须抓住；
 * ③ 豁免注释被删 → 专项审计抓住；
 * ④ gateway 里 fetch 消失 → 豁免已无对象，要求连扫描器逻辑一起撤。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULES, auditGatewaySource, scanSource, stripComments } from './check-no-network.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** 真实的 gateway.ts 源码 —— 审计对象必须和生产一致，不是手搓的近似样本 */
const REAL_GATEWAY_SOURCE = readFileSync(resolve(here, '../src/ai/gateway.ts'), 'utf-8');

describe('check-no-network · 结构性单点', () => {
  it('规则共 11 条（fetch 豁免后其余 10 条照扫）', () => {
    expect(RULES).toHaveLength(11);
    expect(RULES.some((rule) => rule.id === 'fetch')).toBe(true);
  });

  it('★ 真实 gateway.ts：豁免 fetch 后零命中，专项审计通过', () => {
    expect(scanSource(REAL_GATEWAY_SOURCE, { gatewayExemptFetch: true })).toEqual([]);
    expect(auditGatewaySource(REAL_GATEWAY_SOURCE)).toBeNull();
  });

  it('★ 普通文件里的 fetch 必被抓（豁免只属于 gateway 一个文件）', () => {
    const source = 'export function load(url: string) {\n  return fetch(url);\n}\n';
    const hits = scanSource(source);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 2, rule: 'fetch' });
  });

  it('★ gateway 内第二个口子（如 new WebSocket）被专项审计抓住', () => {
    const tampered = `${REAL_GATEWAY_SOURCE}\nconst ws = new WebSocket('ws://x');\n`;
    expect(scanSource(tampered, { gatewayExemptFetch: true }).map((hit) => hit.rule)).toEqual(['websocket']);
    expect(auditGatewaySource(tampered)).toContain('websocket');
  });

  it('gateway 内出现 XMLHttpRequest 同样被专项审计抓住', () => {
    const tampered = `${REAL_GATEWAY_SOURCE}\nconst xhr = new XMLHttpRequest();\n`;
    expect(auditGatewaySource(tampered)).toContain('xhr');
  });

  it('豁免注释被删 → 专项审计要求补回解释', () => {
    const noComment = stripComments(REAL_GATEWAY_SOURCE);
    expect(auditGatewaySource(noComment)).toContain('专项审计注释');
  });

  it('gateway 里 fetch 消失 → 豁免已无对象，必须连扫描器逻辑一起撤', () => {
    const withoutFetch = stripComments(REAL_GATEWAY_SOURCE).replace(/\bfetch\b/g, 'FETCH');
    expect(auditGatewaySource(withoutFetch)).toContain('没有 fetch');
  });

  it('注释里写 fetch 不算数（stripComments 后再判）', () => {
    const source = '// 有人想在注释里写 fetch( 试试\nexport const x = 1;\n';
    expect(scanSource(source)).toEqual([]);
  });
});
