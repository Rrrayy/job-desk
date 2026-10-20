/**
 * 导出格式回归测试。
 *
 * 这类代码最容易「看起来能用、实际一落地就废」：
 * CSV 少了 BOM 就全是乱码、ICS 折行按字符切就把中文切成乱码、
 * 单元格以 `=` 开头会被 Excel 当公式执行。这些都不是类型系统能拦住的，只能靠断言。
 */

import { describe, expect, it } from 'vitest';
import type { Application, DB, Interview } from '../types';
import { emptyDB } from './defaults';
import { buildApplicationsCSV, buildInterviewsICS, csvFilename, icsFilename } from './tableExport';

const NOW = new Date(2026, 9, 20, 10, 0, 0);

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    companyId: 'c-1',
    jobTitle: '前端实习',
    status: 'applied',
    statusChangedAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeDB(apps: Application[], interviews: Interview[] = []): DB {
  const db = emptyDB();
  db.companies = [{ id: 'c-1', name: '某某科技', createdAt: '2026-10-01T00:00:00.000Z' }];
  db.applications = apps;
  db.interviews = interviews;
  return db;
}

describe('CSV', () => {
  it('带 UTF-8 BOM —— 没有它 Excel 打开就是乱码', () => {
    const csv = buildApplicationsCSV(makeDB([makeApp()]), NOW);
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });

  it('表头与数据列数一致', () => {
    const csv = buildApplicationsCSV(makeDB([makeApp()]), NOW);
    const [header, first] = csv.replace('\uFEFF', '').trimEnd().split('\r\n');
    expect(header.split(',')).toHaveLength(15);
    // 末尾一行数据可能因为包含引号内的逗号而"看起来"更长，这里只数一个干净的行
    expect(first.split(',')).toHaveLength(15);
  });

  it('含逗号 / 引号 / 换行的值被正确包裹并转义', () => {
    const csv = buildApplicationsCSV(
      makeDB([makeApp({ jobTitle: '前端,后端"全栈"\n远程' })]),
      NOW,
    );
    expect(csv).toContain('"前端,后端""全栈""\n远程"');
  });

  it('★ 以 = 开头的值被钉成文本（防 Excel 公式注入）', () => {
    const csv = buildApplicationsCSV(makeDB([makeApp({ jobTitle: '=cmd|calc' })]), NOW);
    expect(csv).toContain("'=cmd|calc");
  });

  it('负数不加单引号（防注入不能误伤数据）', () => {
    const csv = buildApplicationsCSV(makeDB([makeApp({ salaryText: '-200' })]), NOW);
    expect(csv).toContain(',-200');
    expect(csv).not.toContain("'-200");
  });

  it('沉默天数与阈值只对有沉默语义的状态填值', () => {
    const applied = makeApp({ id: 'a', jobTitle: '进行中' });
    const onboarded = makeApp({ id: 'b', jobTitle: '已入职', status: 'onboarded' });
    const csv = buildApplicationsCSV(makeDB([applied, onboarded]), NOW);
    const lines = csv.replace('\uFEFF', '').trimEnd().split('\r\n');
    const rowOf = (job: string): string[] => (lines.find((line) => line.includes(job)) ?? '').split(',');
    // 第 10、11 列（索引 9、10）是沉默天数 / 阈值
    expect(rowOf('进行中')[9]).toBe('0');
    expect(rowOf('已入职')[9]).toBe('');
  });

  it('公司名优先取短名', () => {
    const db = makeDB([makeApp()]);
    db.companies = [{ id: 'c-1', name: '某某科技有限公司', shortName: '某某', createdAt: NOW.toISOString() }];
    expect(buildApplicationsCSV(db, NOW)).toContain('某某,前端实习');
  });

  it('文件名用本地日期', () => {
    expect(csvFilename(NOW)).toBe('求职工作台-投递-2026-10-20.csv');
  });
});

describe('ICS', () => {
  const interview: Interview = {
    id: 'iv-1',
    applicationId: 'app-1',
    round: 2,
    scheduledAt: new Date(2026, 9, 22, 15, 30, 0).toISOString(),
    durationMin: 45,
    format: 'video',
    locationOrLink: 'https://meeting.example.com/abc',
    result: 'pending',
    notes: '重点复习; 手写 Promise, 讲解',
  };

  it('是一个合法的 VCALENDAR 骨架', () => {
    const ics = buildInterviewsICS(makeDB([makeApp()], [interview]), NOW);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics.match(/END:VEVENT/g)).toHaveLength(1);
  });

  it('DTSTART / DTEND 用 UTC 形式，且结束时间按 duration 顺延', () => {
    const ics = buildInterviewsICS(makeDB([makeApp()], [interview]), NOW);
    const start = new Date(2026, 9, 22, 15, 30, 0);
    const end = new Date(start.getTime() + 45 * 60 * 1000);
    const stampify = (d: Date): string =>
      `${d.getUTCFullYear()}${`${d.getUTCMonth() + 1}`.padStart(2, '0')}${`${d.getUTCDate()}`.padStart(2, '0')}` +
      `T${`${d.getUTCHours()}`.padStart(2, '0')}${`${d.getUTCMinutes()}`.padStart(2, '0')}${`${d.getUTCSeconds()}`.padStart(2, '0')}Z`;
    expect(ics).toContain(`DTSTART:${stampify(start)}`);
    expect(ics).toContain(`DTEND:${stampify(end)}`);
  });

  it('UID 稳定且唯一（重复导入靠它去重，不能带时间戳）', () => {
    const ics = buildInterviewsICS(makeDB([makeApp()], [interview]), NOW);
    expect(ics).toContain('UID:iv-1@job-desk.local');
  });

  it('TEXT 值里的分号 / 逗号被转义（否则日历会截断成两段）', () => {
    // 这一行会被折行，先把续行接回去再断言，否则测的是折行而不是转义
    const ics = buildInterviewsICS(makeDB([makeApp()], [interview]), NOW).replace(/\r\n /g, '');
    expect(ics).toContain('重点复习\\; 手写 Promise\\, 讲解');
  });

  it('已取消的场次保留但标 CANCELLED', () => {
    const cancelled: Interview = { ...interview, id: 'iv-2', result: 'cancelled' };
    const ics = buildInterviewsICS(makeDB([makeApp()], [cancelled]), NOW);
    expect(ics).toContain('STATUS:CANCELLED');
  });

  it('★ 每行不超过 75 个八位组（中文按字节算），且折行不切断字符', () => {
    const longNote = '很长的面试备注'.repeat(30);
    const long: Interview = { ...interview, id: 'iv-long', notes: longNote };
    const ics = buildInterviewsICS(makeDB([makeApp()], [long]), NOW);
    const encoder = new TextEncoder();
    for (const line of ics.split('\r\n')) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    // 折行后内容仍然完整（把续行连回去应能找回原文）
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain(longNote);
  });

  it('时间是脏数据时跳过该场，而不是导出一个 1970 年的约会', () => {
    const broken: Interview = { ...interview, id: 'iv-bad', scheduledAt: '不是时间' };
    const ics = buildInterviewsICS(makeDB([makeApp()], [broken]), NOW);
    expect(ics).not.toContain('iv-bad');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('文件名用本地日期', () => {
    expect(icsFilename(NOW)).toBe('求职工作台-面试-2026-10-20.ics');
  });
});
