/**
 * 课表文本解析的回归：一行一节课、字段顺序随意、识别不出必须给原因而不是悄悄丢。
 */

import { describe, expect, it } from 'vitest';
import { parseCourseLines } from './courseImport';

describe('parseCourseLines', () => {
  it('标准格式：周几 + 时间段 + 课程名', () => {
    const r = parseCourseLines('周一 08:00-09:40 数据结构');
    expect(r.ok).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
    expect(r.ok[0]).toEqual({ weekday: 1, start: '08:00', end: '09:40', name: '数据结构' });
  });

  it('支持 星期X / 礼拜X / 周X 数字写法', () => {
    const r = parseCourseLines(
      ['星期三 14:00~15:40 计算机网络', '礼拜天 19:00-20:30 晚自习', '周5 18:30-20:10 选修课'].join('\n'),
    );
    expect(r.skipped).toHaveLength(0);
    expect(r.ok.map((c) => c.weekday)).toEqual([3, 7, 5]);
  });

  it('时间段分隔符支持 - ~ — 至 到', () => {
    const r = parseCourseLines(
      [
        '周一 8:00-9:40 A',
        '周一 8:00~9:40 B',
        '周一 8:00—9:40 C',
        '周一 8:00至9:40 D',
        '周一 8:00到9:40 E',
      ].join('\n'),
    );
    expect(r.skipped).toHaveLength(0);
    expect(r.ok).toHaveLength(5);
    for (const c of r.ok) {
      expect(c.start).toBe('08:00');
      expect(c.end).toBe('09:40');
    }
  });

  it('字段顺序随意：课程名在前面也能识别', () => {
    const r = parseCourseLines('数据库系统 周五 18:30-20:10');
    expect(r.ok[0]).toMatchObject({ weekday: 5, start: '18:30', end: '20:10', name: '数据库系统' });
  });

  it('小时不满两位自动补零', () => {
    const r = parseCourseLines('周二 8:05-9:45 早课');
    expect(r.ok[0].start).toBe('08:05');
    expect(r.ok[0].end).toBe('09:45');
  });

  it('支持全角冒号', () => {
    const r = parseCourseLines('周一 08：00-09：40 数据结构');
    expect(r.ok[0]).toMatchObject({ start: '08:00', end: '09:40' });
  });

  it('多行混合：空行 / 注释行跳过且不计入 skipped', () => {
    const r = parseCourseLines(
      ['# 课表 2026 春', '', '周一 08:00-09:40 数据结构', '// 从教务系统复制的', '周三 14:00-15:40 网络'].join('\n'),
    );
    expect(r.ok).toHaveLength(2);
    expect(r.skipped).toHaveLength(0);
  });

  it('没有周几 → skipped 并给原因', () => {
    const r = parseCourseLines('08:00-09:40 数据结构');
    expect(r.ok).toHaveLength(0);
    expect(r.skipped[0].reason).toContain('周几');
  });

  it('没有时间段 → skipped', () => {
    const r = parseCourseLines('周一 数据结构');
    expect(r.skipped[0].reason).toContain('时间段');
  });

  it('开始晚于结束 → skipped', () => {
    const r = parseCourseLines('周一 10:00-08:00 反了');
    expect(r.skipped[0].reason).toContain('不早于');
  });

  it('时间越界（25:00）→ skipped', () => {
    const r = parseCourseLines('周一 25:00-26:00 不存在的一节课');
    expect(r.skipped[0].reason).toContain('不合法');
  });

  it('缺课程名 → skipped', () => {
    const r = parseCourseLines('周一 08:00-09:40');
    expect(r.skipped[0].reason).toContain('课程名');
  });

  it('坏行不影响好行：好行照常进 ok', () => {
    const r = parseCourseLines('周一 08:00-09:40 数据结构\n这行是乱的');
    expect(r.ok).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].line).toBe('这行是乱的');
  });

  it('同一门课多行录入各自独立', () => {
    const r = parseCourseLines('周一 08:00-09:40 英语（单周）\n周三 08:00-09:40 英语（双周）');
    expect(r.ok).toHaveLength(2);
    expect(r.ok[0].weekday).toBe(1);
    expect(r.ok[1].weekday).toBe(3);
  });
});
