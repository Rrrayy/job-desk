/**
 * BOSS 直聘「沟通中 / 已投递」列表页解析。
 *
 * 已知限制（同时写进 README.md 与 docs/adapters/boss.md）：
 * - 拿不到 externalId（纯文本没有 href）→ 去重靠 matchKey + 模糊匹配；
 * - 拿不到「最后一条消息是谁发的」→「沟通中」一律按 chatting / high 处理（架构 §8-歧义 3）；
 * - 列表虚拟滚动时 Ctrl+A 只能拿到已渲染的条目，所以「识别 N 条」小于总条数是正常的。
 */

import type { AdapterInput, AdapterResult, ParseContext } from '../types';
import { parseListLike } from '../shared';

export function parseBossText(input: AdapterInput, ctx: ParseContext): AdapterResult {
  return parseListLike(input.text || '', ctx.now);
}
