/**
 * 证据可追溯（v0.10 / L2-4）。
 *
 * 模型给的 `evidence` 有两种坏法：
 * 1. **编造**：写一句原文里根本没有的话，看起来特别像证据；
 * 2. **改写**：把原句润色一下再引用，人眼看不出，程序也对不上。
 *
 * 两种都会让「点击证据回看原文」变成空头支票。所以在建议**写库之前**核对一次：
 * 能在来源文本里定位的保留，定位不到的**摘掉证据字段**（建议本身保留 ——
 * 内容是给用户判断的，证据是给用户核对的，缺证据不等于内容一定错）。
 *
 * 口径刻意宽松一点（前缀 12 字命中即算），因为模型常把长句截短；
 * 但门槛设在 4 个有效字符以上，避免「前端」「项目」这类词乱命中。
 */

/** 归一化：全角转半角 → 去空白 → 去常见标点 → 小写（只用于比对，不改展示） */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/[，。；：、！？""''（）《》〈〉【】\-—…·,.;:!?"'()[\]{}|/\\]/g, '')
    .toLowerCase();
}

/** 有效证据的最短长度（低于它无法证实，宁可判为「无据」） */
const MIN_EVIDENCE_CHARS = 4;
/** 长句截短后的前缀命中长度 */
const PREFIX_CHARS = 12;
/** 拼接两句时的尾部命中长度 */
const SUFFIX_CHARS = 10;

/**
 * 这条证据能否在来源文本里定位。
 * 三个方向：全文命中 → 前缀命中（模型截短）→ 后缀命中（模型多拼了前半句）。
 */
export function evidenceSupported(evidence: string, source: string): boolean {
  const e = normalizeForMatch(evidence);
  const s = normalizeForMatch(source);
  if (!e || !s) return false;
  if (e.length < MIN_EVIDENCE_CHARS) return false;
  if (s.includes(e)) return true;
  if (e.length >= PREFIX_CHARS && s.includes(e.slice(0, PREFIX_CHARS))) return true;
  if (e.length >= PREFIX_CHARS && s.includes(e.slice(-SUFFIX_CHARS))) return true;
  return false;
}

/**
 * 批量核对：不命中的条目摘掉 `evidence`（其余字段原样保留），并报出摘了几条。
 * 返回**新数组**，不修改入参 —— 调用方可能在别处还要用原 items。
 */
export function auditEvidence<T extends { evidence?: string }>(
  items: T[],
  source: string,
): { items: T[]; unverified: number } {
  let unverified = 0;
  const out = items.map((item) => {
    if (!item.evidence) return item;
    if (evidenceSupported(item.evidence, source)) return item;
    unverified += 1;
    const rest = { ...item };
    delete rest.evidence;
    return rest;
  });
  return { items: out, unverified };
}
