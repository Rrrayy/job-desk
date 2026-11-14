/**
 * 模块二 · 公司五个新字段的清洗与概览行（纯函数）。
 *
 * 两个容易被做错的地方：
 * 1. `employeeReview`（员工口碑）与既有 `impression`（面试体感）**是两个字段**。
 *    合成一个的结果是用户永远只填一种。
 * 2. 概览行**空值不产生行**：全空时界面上不出现「规模：—」这种占位（COM-2 验收）。
 */

import type { Company, CompanyStage } from '../../types';

/** 融资阶段枚举（7 值，只增不改） */
export const COMPANY_STAGES: readonly CompanyStage[] = ['angel', 'a', 'b', 'c', 'd', 'listed', 'unknown'];

/** 枚举 → 中文。'unknown' 表示「查过但没查到」，与「没填」在界面上必须能区分 */
export const COMPANY_STAGE_LABEL: Record<CompanyStage, string> = {
  angel: '天使轮',
  a: 'A 轮',
  b: 'B 轮',
  c: 'C 轮',
  d: 'D 轮及以后',
  listed: '已上市',
  unknown: '查过没查到',
};

/** 五个新字段的补丁形状（`api.company.saveExtras` 的入参） */
export type CompanyExtraPatch = Partial<
  Pick<Company, 'scale' | 'financingStage' | 'website' | 'industryDetail' | 'employeeReview'>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, limit);
}

function isCompanyStage(value: unknown): value is CompanyStage {
  return typeof value === 'string' && (COMPANY_STAGES as readonly string[]).includes(value);
}

/**
 * 归一化公司五个新字段。
 * 全空 → 返回空对象（每个键都不出现），**不写 `scale: ''` 这种空串占位** ——
 * 否则「旧数据没有这个字段」与「用户填了空」就分不出来了（契约 4）。
 */
/**
 * 五个扩展字段的键。
 *
 * 写库时要「有值就写、没值就删键」（不写空串，否则「旧数据没这个字段」与
 * 「用户填了个空」分不出来），所以需要一份可枚举的清单 —— 手写第二份必然漏。
 */
export const COMPANY_EXTRA_KEYS = [
  'scale',
  'financingStage',
  'website',
  'industryDetail',
  'employeeReview',
] as const;

export function normalizeCompanyExtras(raw: unknown): CompanyExtraPatch {
  if (!isRecord(raw)) return {};
  const out: CompanyExtraPatch = {};
  const scale = asText(raw.scale, 40);
  if (scale) out.scale = scale;
  if (isCompanyStage(raw.financingStage)) out.financingStage = raw.financingStage;
  // 官网只放行 http(s)：这条数据会被渲染成 <a href>，脏协议必须挡在写库前
  const website = asText(raw.website, 200);
  if (website && /^https?:\/\//i.test(website)) out.website = website;
  const industryDetail = asText(raw.industryDetail, 40);
  if (industryDetail) out.industryDetail = industryDetail;
  const employeeReview = asText(raw.employeeReview, 300);
  if (employeeReview) out.employeeReview = employeeReview;
  return out;
}

export interface CompanyOverviewRow {
  label: string;
  value: string;
  /** 有值时渲染成链接（官网） */
  href?: string;
}

/**
 * 公司概览行：**空字段不产生行**。
 * 顺序 = 用户读一家公司的顺序：是什么 → 多大 → 到哪一轮 → 在哪 → 谁推的 → 我面着怎么样 → 这家怎么样。
 */
export function companyOverviewRows(company: Company): CompanyOverviewRow[] {
  const rows: CompanyOverviewRow[] = [];
  const push = (label: string, value?: string, href?: string): void => {
    const text = (value ?? '').trim();
    if (!text) return;
    rows.push(href ? { label, value: text, href } : { label, value: text });
  };

  if (company.shortName && company.shortName !== company.name) push('简称', company.shortName);
  push('行业', company.industry);
  push('行业细分', company.industryDetail);
  push('规模', company.scale);
  if (company.financingStage) push('融资阶段', COMPANY_STAGE_LABEL[company.financingStage]);
  push('官网', company.website, company.website);
  push('城市', company.city);
  push('内推人', company.referrer);
  // ★ 两个字段两个标签：合并显示会让用户以为它们是一回事
  push('面试体感', company.impression);
  push('员工口碑', company.employeeReview);
  return rows;
}

/** 公司全名 + 简称的展示串（「字节跳动（字节）」）；没有简称就只显示全名 */
export function companyFullLabel(company: Company): string {
  const shortName = (company.shortName ?? '').trim();
  return shortName && shortName !== company.name ? `${company.name}（${shortName}）` : company.name;
}
