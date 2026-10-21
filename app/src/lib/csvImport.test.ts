/**
 * CSV / JSON 字段自动映射（v0.6 / P1）回归。
 *
 * 这一组的重点是「**认不出来的时候有没有诚实地说出来**」：
 * 静默丢掉一列、或者把「笔试」硬塞进一个不存在的状态，
 * 比直接报错更坏 —— 用户会以为导入成功了。
 */

import { describe, expect, it } from 'vitest';
import {
  buildDBFromCSV,
  mapHeaders,
  normalizeChannel,
  normalizeDate,
  normalizeHeader,
  normalizeStatus,
  parseCSV,
  previewCSV,
} from './csvImport';
import { emptyDB } from './defaults';

const TODAY = '2026-10-21';

describe('P1 · CSV 解析（引号 / 换行 / BOM / CRLF）', () => {
  it('双引号内的逗号不会被切碎', () => {
    const rows = parseCSV('公司,岗位\n"字节, Inc.",前端');
    expect(rows).toEqual([
      ['公司', '岗位'],
      ['字节, Inc.', '前端'],
    ]);
  });

  it('双引号内的换行与 "" 转义', () => {
    const rows = parseCSV('a,b\n"第一行\n第二行","他说""你好"""');
    expect(rows[1][0]).toBe('第一行\n第二行');
    expect(rows[1][1]).toBe('他说"你好"');
  });

  it('CRLF 与 UTF-8 BOM 都能处理', () => {
    const rows = parseCSV('\uFEFF公司,岗位\r\n字节,前端\r\n');
    expect(rows).toEqual([
      ['公司', '岗位'],
      ['字节', '前端'],
    ]);
  });

  it('空行被跳过，但单元格为空的行保留', () => {
    const rows = parseCSV('公司,岗位\n\n,前端\n');
    expect(rows).toHaveLength(2);
  });
});

describe('P1 · 表头映射', () => {
  it('常见中文表头全部命中', () => {
    const mapped = mapHeaders(['公司名称', '应聘岗位', '投递状态', '投递渠道', '投递日期', '城市', '备注']);
    expect(mapped.map((item) => item.field)).toEqual([
      'company',
      'jobTitle',
      'status',
      'channel',
      'appliedAt',
      'city',
      'notes',
    ]);
  });

  it('全角 / 空格 / 大小写都不敏感', () => {
    expect(normalizeHeader('　公司 名称　')).toBe('公司名称');
    expect(mapHeaders(['ＣＯＭＰＡＮＹ'])[0].field).toBe('company');
  });

  it('同一字段不会被两列抢走（先到先得，后者进忽略清单）', () => {
    const mapped = mapHeaders(['公司', '公司名', '岗位']);
    expect(mapped[0].field).toBe('company');
    expect(mapped[1].field).toBeNull();
    expect(mapped[2].field).toBe('jobTitle');
  });

  it('认不出来的表头必须是 null，而不是硬猜', () => {
    const mapped = mapHeaders(['公司', '花里胡哨的列', '岗位']);
    expect(mapped[1].field).toBeNull();
  });
});

describe('P1 · 取值清洗', () => {
  it('状态：笔试 / 测评落到「已沟通」（9 状态里没有笔试这一档）', () => {
    expect(normalizeStatus('笔试')).toBe('chatting');
    expect(normalizeStatus('测评')).toBe('chatting');
    expect(normalizeStatus('已约面')).toBe('scheduled');
    expect(normalizeStatus('等结果')).toBe('interviewing');
    expect(normalizeStatus('已入职')).toBe('onboarded');
    expect(normalizeStatus('归档')).toBe('dropped');
    expect(normalizeStatus('莫名其妙的状态')).toBeNull();
  });

  it('渠道别名', () => {
    expect(normalizeChannel('BOSS直聘')).toBe('boss');
    expect(normalizeChannel('内推')).toBe('referral');
    expect(normalizeChannel('猎聘')).toBe('liepin');
    expect(normalizeChannel('某某内推群')).toBeNull();
  });

  it('日期：四种写法都归一，带时间的只取日期', () => {
    expect(normalizeDate('2026-10-21', TODAY)).toBe('2026-10-21');
    expect(normalizeDate('2026/10/21', TODAY)).toBe('2026-10-21');
    expect(normalizeDate('2026.10.21', TODAY)).toBe('2026-10-21');
    expect(normalizeDate('2026年10月21日', TODAY)).toBe('2026-10-21');
    expect(normalizeDate('2026-10-21 14:12:00', TODAY)).toBe('2026-10-21');
  });

  it('日期认不出来 → 回落到今天，不抛错', () => {
    expect(normalizeDate('上周三', TODAY)).toBe(TODAY);
    expect(normalizeDate('2026-13-40', TODAY)).toBe(TODAY);
    expect(normalizeDate('', TODAY)).toBe(TODAY);
  });
});

describe('P1 · 预览必须诚实', () => {
  it('缺公司名的行被跳过并给出原因（不许用岗位名冒充公司）', () => {
    const preview = previewCSV('公司,岗位\n,前端\n字节,后端', TODAY);
    expect(preview.rows).toHaveLength(1);
    expect(preview.skipped).toBe(1);
    expect(preview.rowIssues.some((issue) => issue.reason.includes('缺少公司名'))).toBe(true);
  });

  it('认不出的状态 / 渠道 / 日期都进 rowIssues，而不是静默替换', () => {
    const preview = previewCSV('公司,岗位,状态,渠道,投递日期\n字节,前端,玄学状态,天上掉下来,上古时代', TODAY);
    const joined = preview.rowIssues.map((issue) => issue.reason).join('\n');
    expect(joined).toContain('玄学状态');
    expect(joined).toContain('天上掉下来');
    expect(joined).toContain('上古时代');
  });

  it('认不出的列进 unmapped，且带 reason', () => {
    const preview = previewCSV('公司,岗位,玄学列\n字节,前端,x', TODAY);
    expect(preview.unmapped).toHaveLength(1);
    expect(preview.unmapped[0]).toMatchObject({ header: '玄学列' });
    expect(preview.unmapped[0].reason.length).toBeGreaterThan(4);
  });

  it('没有表头 → 按第 1 列公司、第 2 列岗位推断，并明确告知', () => {
    const preview = previewCSV('字节,前端\n腾讯,后端', TODAY);
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toMatchObject({ company: '字节', jobTitle: '前端' });
    expect(preview.rowIssues[0].reason).toContain('第 1 列=公司');
  });

  it('空文件 → 一条明确的 issue，不是空预览当成功', () => {
    const preview = previewCSV('\n\n', TODAY);
    expect(preview.rows).toHaveLength(0);
    expect(preview.rowIssues[0].reason).toContain('没有任何非空行');
  });
});

describe('P1 · 落库（去重键与 JSON 导入一致）', () => {
  const csv = '公司,岗位,状态,投递日期,备注\n字节,前端,已投递,2026-10-20,内推人张三\n腾讯,后端,面试中,2026/10/19,';

  it('新建投递 + 公司，日期与状态都清洗过', () => {
    const preview = previewCSV(csv, TODAY);
    const result = buildDBFromCSV(emptyDB(), preview, '2026-10-21T00:00:00.000Z');
    expect(result.added).toBe(2);
    expect(result.db.applications).toHaveLength(2);
    expect(result.db.companies).toHaveLength(2);

    const bytedance = result.db.applications.find((app) => app.jobTitle === '前端');
    expect(bytedance?.status).toBe('applied');
    expect(bytedance?.appliedAt).toBe('2026-10-20');
    // 备注落到时间线（Application 上没有 notes 字段），并标明来源是 CSV
    const memo = result.db.notes.find((note) => note.applicationId === bytedance?.id);
    expect(memo?.content).toBe('内推人张三');
    expect(memo?.type).toBe('memo');
  });

  it('同一份 CSV 导入两次，第二次全部跳过（不重复插入）', () => {
    const first = buildDBFromCSV(emptyDB(), previewCSV(csv, TODAY), '2026-10-21T00:00:00.000Z');
    const second = buildDBFromCSV(first.db, previewCSV(csv, TODAY), '2026-10-21T00:00:00.000Z');
    expect(second.added).toBe(0);
    expect(second.skippedExisting).toBe(2);
    expect(second.db.applications).toHaveLength(2);
    expect(second.db.companies).toHaveLength(2);
  });

  it('公司名只有空白/大小写差异时视为同一家公司', () => {
    const a = buildDBFromCSV(emptyDB(), previewCSV('公司,岗位\n字节,前端', TODAY), '2026-10-21T00:00:00.000Z');
    const b = buildDBFromCSV(a.db, previewCSV('公司,岗位\n 字节 ,后端', TODAY), '2026-10-21T00:00:00.000Z');
    expect(b.added).toBe(1);
    expect(b.db.companies).toHaveLength(1);
  });

  it('不在时间线上造假事件（CSV 没有时间线信息，除了备注）', () => {
    const noNotes = '公司,岗位,投递日期\n字节,前端,2026-10-20';
    const result = buildDBFromCSV(emptyDB(), previewCSV(noNotes, TODAY), '2026-10-21T00:00:00.000Z');
    expect(result.db.notes).toHaveLength(0);
    expect(result.db.events).toHaveLength(0);
  });
});
