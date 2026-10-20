/**
 * 名字归一化 —— 去重的唯一依据。
 *
 * 归一化规则变更时必须把 NORMALIZE_VERSION +1，
 * 否则旧的 matchKey 会把「本该匹配」的两条判成不同（D-08）。
 */

/** 归一化规则版本；写入 Application.sync.matchKeyVersion，命中前必须校验 */
export const NORMALIZE_VERSION = 1;

/** 去后缀用：**长的必须先剥**，循环剥到不再变化 */
const LEGAL_SUFFIXES = [
  '有限责任公司',
  '股份有限公司',
  '有限公司',
  '集团有限公司',
  '网络科技有限公司',
  '信息技术有限公司',
  '科技有限公司',
  '集团',
  '科技',
  '网络',
  '信息',
  '技术',
  '控股',
  '股份',
];

export const CITY_WORDS = [
  '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州', '天津', '重庆',
  '长沙', '郑州', '合肥', '厦门', '福州', '济南', '青岛', '大连', '沈阳', '哈尔滨', '长春', '昆明',
  '南昌', '贵阳', '南宁', '太原', '石家庄', '兰州', '乌鲁木齐', '呼和浩特', '海口', '珠海', '东莞',
  '佛山', '无锡', '宁波',
];

/** 岗位相似度阈值：低于它就不合并（宁可多显示「新增」，也不能错并） */
export const TITLE_SIMILARITY = 0.8;

/** 全角 → 半角（ASCII 区 + 数字/字母 + 全角空格） */
export function toHalfWidth(input: string): string {
  return input
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 去掉所有空白与常见分隔装饰符（括号内容**保留** —— 公司名里括号常是分支名） */
function stripSpacesAndMarks(input: string): string {
  return input.replace(/[\s（）()【】\[\]·・\-—_.,，。]/g, '');
}

/** 循环剥合法后缀，直到不再变化 */
function stripLegalSuffix(input: string): string {
  let current = input;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (current.length > suffix.length && current.endsWith(suffix)) {
        current = current.slice(0, current.length - suffix.length);
        changed = true;
        break;
      }
    }
  }
  return current;
}

/**
 * 公司名归一化：全角→半角 → 去空白与括号符 → 循环剥合法后缀 → 小写
 * 例：'北京三快在线科技有限公司' → '北京三快在线'
 *     'ＢＹＴＥＤＡＮＣＥ （北京）' → 'bytedance北京'
 */
export function normalizeCompanyName(input: string): string {
  if (!input) return '';
  return stripLegalSuffix(stripSpacesAndMarks(toHalfWidth(input))).toLowerCase();
}

/**
 * 岗位名归一化：全角→半角 → 去括号及内容 → 去城市词 → 去空白 → 小写
 * 例：'前端开发实习生（base北京）' → '前端开发实习生'
 *     '前端开发工程师-抖音' → '前端开发工程师-抖音'（保留 -，Dice 会自然处理）
 */
export function normalizeJobTitle(input: string): string {
  if (!input) return '';
  let text = toHalfWidth(input);
  text = text.replace(/[（(【\[［][^）)】\]］]*[）)】\]］]/g, '');
  for (const city of CITY_WORDS) {
    text = text.split(city).join('');
  }
  return text.replace(/\s/g, '').toLowerCase();
}

/** 二元组多重集 */
function bigramCounts(input: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (input.length === 0) return counts;
  if (input.length === 1) {
    counts.set(input, 1);
    return counts;
  }
  for (let i = 0; i < input.length - 1; i += 1) {
    const gram = input.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * 二元组 Dice 系数（**多重集**口径）。
 * dice = 2 * |A ∩ B| / (|A| + |B|)，交点按计数取小。
 * 空串 → 0；长度 1 退化为单字符集合比较。
 */
export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = bigramCounts(a);
  const right = bigramCounts(b);
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of left.values()) leftTotal += count;
  for (const count of right.values()) rightTotal += count;
  if (leftTotal === 0 || rightTotal === 0) return 0;
  let overlap = 0;
  for (const [gram, count] of left.entries()) {
    const other = right.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (leftTotal + rightTotal);
}

/** matchKey = 归一化公司 + '|' + 归一化岗位（写入时存一份快照） */
export function buildMatchKey(companyName: string, jobTitle: string | undefined): string {
  return `${normalizeCompanyName(companyName)}|${normalizeJobTitle(jobTitle ?? '')}`;
}

/** 两个岗位名是否「像同一个岗位」 */
export function isSimilarTitle(a: string, b: string): boolean {
  return diceCoefficient(normalizeJobTitle(a), normalizeJobTitle(b)) >= TITLE_SIMILARITY;
}
