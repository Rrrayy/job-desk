/**
 * custom 兜底适配器：不认平台，只认「一段一段的公司名 + 岗位名」。
 * 本质是「粘贴表格解析」——用户从 Excel / 记事本 / 任何页面复制来的都试一下。
 * 它是所有解析失败的最后一层保险，也是社区新增平台的模板。
 */

import type { AdapterInput, AdapterResult, ParseContext } from '../types';
import { parseListLike } from '../shared';

export function parseCustomText(input: AdapterInput, ctx: ParseContext): AdapterResult {
  const tabular = parseTabular(input.text || '', ctx.now);
  if (tabular.records.length > 0) return tabular;
  return parseListLike(input.text || '', ctx.now, { assumeCompanyFromFirstLine: true });
}

/**
 * 表格形态：一行一条，列之间是 Tab / 多个空格 / 竖线。
 * 只认前两列（公司、岗位），后面的列能读出来就当附加信息。
 */
function parseTabular(text: string, nowIso: string): AdapterResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const records: AdapterResult['records'] = [];
  const unparsed: AdapterResult['unparsed'] = [];

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    const cells = raw.split(/\t+|\s{3,}|\s*\|\s*/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    // 表头行
    if (/公司|企业|单位/.test(cells[0]) && /岗位|职位/.test(cells[1])) continue;

    const companyName = cells[0];
    const jobTitle = cells[1];
    if (!companyName || companyName.length > 40) {
      unparsed.push({ rawSnippet: raw.slice(0, 500), reason: '第一列不像公司名' });
      continue;
    }
    records.push({
      companyName,
      jobTitle: jobTitle && jobTitle.length <= 40 ? jobTitle : undefined,
      rawSnippet: raw.slice(0, 500),
      confidence: { companyName: 'medium', jobTitle: jobTitle ? 'medium' : 'low' },
      overall: jobTitle ? 'medium' : 'low',
    });
    void nowIso;
  }
  return { records, unparsed };
}
