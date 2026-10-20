/**
 * 课表文本解析（v0.4）。
 *
 * 设计：不绑定任何教务系统格式 —— 用户从课表 App / 教务网页 / Excel 里复制出
 * 「周几 + 时间段 + 课程名」就能进。一行一节课，两个字段的先后无所谓。
 *
 *   周一 08:00-09:40 数据结构
 *   星期三 14:00~15:40 计算机网络
 *   数据库 周五 18:30-20:10     ← 顺序随意
 *
 * 识别不出来不悄悄丢：逐行给出原因，让用户自己改。
 */

export interface ParsedCourse {
  weekday: number;
  start: string;
  end: string;
  name: string;
}

export interface ParseCourseResult {
  ok: ParsedCourse[];
  skipped: Array<{ line: string; reason: string }>;
}

const CN_DIGIT_WEEKDAY: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7,
};

/** 周一 / 星期二 / 礼拜天 / 周3 … */
const WEEKDAY_RE = /(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/;
/** 08:00-09:40 / 8:00～9:40 / 18:30 至 20:10 … */
const TIME_RE = /(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:-|–|—|~|～|至|到)\s*(\d{1,2})\s*[:：]\s*(\d{2})/;

function normalizeTime(h: string, m: string): string | null {
  const hour = Number(h);
  const min = Number(m);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(min) || min < 0 || min > 59) return null;
  return `${String(hour).padStart(2, '0')}:${m.length === 2 ? m : String(min).padStart(2, '0')}`;
}

/** 解析一段课表文本。纯函数：同样的输入永远得到同样的输出 */
export function parseCourseLines(text: string): ParseCourseResult {
  const ok: ParsedCourse[] = [];
  const skipped: Array<{ line: string; reason: string }> = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const wdMatch = WEEKDAY_RE.exec(line);
    if (!wdMatch) {
      skipped.push({ line, reason: '没找到「周几」（例：周一 / 星期三 / 礼拜五）' });
      continue;
    }
    const weekday = CN_DIGIT_WEEKDAY[wdMatch[1]];
    if (!weekday) {
      skipped.push({ line, reason: `认不出星期几：「${wdMatch[1]}」` });
      continue;
    }

    const timeMatch = TIME_RE.exec(line);
    if (!timeMatch) {
      skipped.push({ line, reason: '没找到时间段（例：08:00-09:40，也支持 ~ 至 到）' });
      continue;
    }
    const start = normalizeTime(timeMatch[1], timeMatch[2]);
    const end = normalizeTime(timeMatch[3], timeMatch[4]);
    if (!start || !end) {
      skipped.push({ line, reason: '时间不合法（小时 0-23，分钟 0-59）' });
      continue;
    }
    if (start >= end) {
      skipped.push({ line, reason: `开始时间 ${start} 不早于结束时间 ${end}` });
      continue;
    }

    // 课程名 = 整行去掉「周几」「时间段」后的剩余部分
    const name = line
      .replace(timeMatch[0], ' ')
      .replace(wdMatch[0], ' ')
      .replace(/[\s,，;；、|]+/g, ' ')
      .trim();
    if (!name) {
      skipped.push({ line, reason: '没找到课程名' });
      continue;
    }

    ok.push({ weekday, start, end, name: name.slice(0, 60) });
  }

  return { ok, skipped };
}
