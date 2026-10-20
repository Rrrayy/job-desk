import { describe, expect, it } from 'vitest';
import {
  NORMALIZE_VERSION,
  TITLE_SIMILARITY,
  buildMatchKey,
  diceCoefficient,
  normalizeCompanyName,
  normalizeJobTitle,
  toHalfWidth,
} from './normalize';

describe('全角转半角', () => {
  it('字母数字与全角空格', () => {
    expect(toHalfWidth('ＢＹＴＥＤＡＮＣＥ　１')).toBe('BYTEDANCE 1');
  });
});

describe('公司名归一化', () => {
  it('剥掉「有限公司 + 科技」两层后缀', () => {
    expect(normalizeCompanyName('北京三快在线科技有限公司')).toBe('北京三快在线');
  });

  it('括号内容保留（公司名里的括号常是分支名）', () => {
    expect(normalizeCompanyName('ＢＹＴＥＤＡＮＣＥ （北京）')).toBe('bytedance北京');
  });

  it('顺序无关：先剥长后缀还是先剥短后缀结果一致', () => {
    expect(normalizeCompanyName('某某网络科技有限公司')).toBe(normalizeCompanyName('某某网络科技'));
  });

  it('【硬约束 2】去后缀不能吃掉有效信息：小米 vs 小米有品 必须不同', () => {
    expect(normalizeCompanyName('小米')).not.toBe(normalizeCompanyName('小米有品'));
  });

  it('【硬约束 2】三快在线 vs 三快在线科技 必须相同', () => {
    expect(normalizeCompanyName('三快在线')).toBe(normalizeCompanyName('三快在线科技'));
  });

  it('空串安全', () => {
    expect(normalizeCompanyName('')).toBe('');
  });
});

describe('岗位名归一化', () => {
  it('去掉括号内容与城市词', () => {
    expect(normalizeJobTitle('前端开发实习生（base北京）')).toBe('前端开发实习生');
  });

  it('保留连字符交给 Dice 处理', () => {
    expect(normalizeJobTitle('前端开发工程师-抖音')).toBe('前端开发工程师-抖音');
  });

  it('方括号同样去掉', () => {
    expect(normalizeJobTitle('后端开发【上海】')).toBe('后端开发');
  });
});

describe('Dice 系数', () => {
  it('完全相同 = 1', () => {
    expect(diceCoefficient('前端开发', '前端开发')).toBe(1);
  });

  it('毫无交集 = 0', () => {
    expect(diceCoefficient('前端开发', '财务会计')).toBe(0);
  });

  it('空串 = 0', () => {
    expect(diceCoefficient('', '前端')).toBe(0);
  });

  it('长度 1 退化为单字符比较', () => {
    expect(diceCoefficient('前', '前')).toBe(1);
  });

  it('【硬约束 3】实习生 vs 工程师 低于阈值，不合并', () => {
    const score = diceCoefficient(normalizeJobTitle('前端开发实习生'), normalizeJobTitle('前端开发工程师'));
    expect(score).toBeLessThan(TITLE_SIMILARITY);
  });

  it('同岗位不同写法高于阈值', () => {
    const score = diceCoefficient(normalizeJobTitle('抖音前端开发实习生'), normalizeJobTitle('抖音前端开发实习生（北京）'));
    expect(score).toBeGreaterThanOrEqual(TITLE_SIMILARITY);
  });
});

describe('matchKey', () => {
  it('格式是「归一化公司|归一化岗位」', () => {
    expect(buildMatchKey('北京三快在线科技有限公司', '前端开发实习生（北京）')).toBe('北京三快在线|前端开发实习生');
  });

  it('岗位为空时不炸，且与「公司|空」一致', () => {
    expect(buildMatchKey('字节跳动', undefined)).toBe('字节跳动|');
  });

  it('归一化版本号是正整数（改归一化规则必须 +1）', () => {
    expect(Number.isInteger(NORMALIZE_VERSION)).toBe(true);
    expect(NORMALIZE_VERSION).toBeGreaterThanOrEqual(1);
  });
});
