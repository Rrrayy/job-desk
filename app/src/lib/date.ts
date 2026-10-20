/**
 * 日期与时间工具。
 * 全部以「本地自然日」为准 —— 沉默天数按自然日差计算，不用 UTC，避免时区错位。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 宽松解析：纯日期字符串（YYYY-MM-DD）按本地零点解析，其余交给 Date */
export function parseFlexible(input: string | null | undefined): Date {
  if (!input) return new Date(NaN);
  const text = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split('-').map((part) => Number(part));
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }
  return new Date(text);
}

/** 本地自然日零点 */
export function startOfDay(input: Date | string): Date {
  const base = typeof input === 'string' ? parseFlexible(input) : new Date(input.getTime());
  if (isNaN(base.getTime())) return new Date(NaN);
  const d = new Date(base.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Date → YYYY-MM-DD（本地） */
export function toDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天的 YYYY-MM-DD */
export function todayISO(now: Date = new Date()): string {
  return toDateISO(now);
}

/** b 与 a 的自然日差（b 晚于 a 为正） */
export function daysBetween(from: Date | string, to: Date | string): number {
  const a = startOfDay(from);
  const b = startOfDay(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** 是否同一天 */
export function isSameDay(a: Date | string, b: Date | string): boolean {
  return toDateISO(startOfDay(a)) === toDateISO(startOfDay(b));
}

/** 加天数（不修改入参） */
export function addDays(d: Date, n: number): Date {
  const next = new Date(d.getTime());
  next.setDate(next.getDate() + n);
  return next;
}

/** 加月数，返回目标月 1 号 */
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** 本周一 00:00（周一为一周起点） */
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const iso = day.getDay() === 0 ? 7 : day.getDay(); // 周日=7
  return addDays(day, -(iso - 1));
}

/** ISO 星期：1=周一 … 7=周日 */
export function weekdayOf(d: Date): number {
  const w = d.getDay();
  return w === 0 ? 7 : w;
}

export const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function weekdayCn(d: Date): string {
  return WEEKDAY_CN[weekdayOf(d) - 1];
}

/** 3/12 形式；无值返回占位符 */
export function fmtDate(value?: string | null, placeholder = '—'): string {
  if (!value) return placeholder;
  const d = parseFlexible(value);
  if (isNaN(d.getTime())) return placeholder;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 3月12日 形式 */
export function fmtDateCn(value?: string | null, placeholder = '—'): string {
  if (!value) return placeholder;
  const d = parseFlexible(value);
  if (isNaN(d.getTime())) return placeholder;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 15:00 */
export function fmtTime(value: string): string {
  const d = parseFlexible(value);
  if (isNaN(d.getTime())) return '--:--';
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
}

/** 3/12 15:00 */
export function fmtDateTime(value: string): string {
  const d = parseFlexible(value);
  if (isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(value)}`;
}

/** 'HH:mm' → 分钟数，非法返回 NaN */
export function timeToMinutes(hhmm: string): number {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return NaN;
  const [h, m] = hhmm.split(':').map((p) => Number(p));
  return h * 60 + m;
}

/** ISO → datetime-local input 的值（YYYY-MM-DDTHH:mm，本地） */
export function toLocalDateTimeInput(iso: string): string {
  const d = parseFlexible(iso);
  if (isNaN(d.getTime())) return '';
  const date = toDateISO(d);
  const time = `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
  return `${date}T${time}`;
}

/** datetime-local input 的值 → ISO 字符串 */
export function fromLocalDateTimeInput(value: string): string {
  const d = parseFlexible(value);
  if (isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

/** 距离目标时间的口语化倒计时 */
export function relativeCountdown(target: Date, now: Date): string {
  const diffDays = daysBetween(now, target);
  if (isSameDay(target, now)) return `今天 ${fmtTime(target.toISOString())}`;
  if (diffDays === 1) return `明天 ${fmtTime(target.toISOString())}`;
  if (diffDays === 2) return `后天 ${fmtTime(target.toISOString())}`;
  if (diffDays > 2) return `${diffDays} 天后`;
  if (diffDays === -1) return `昨天 ${fmtTime(target.toISOString())}`;
  return `${Math.abs(diffDays)} 天前`;
}

/** 毫秒时间戳，非法值给 0，用于排序 */
export function timeValue(value?: string | null): number {
  if (!value) return 0;
  const d = parseFlexible(value);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
