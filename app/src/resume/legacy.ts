/**
 * 旧数据（v0.9 之前录入的投递）的识别与分组（v0.9.1 / R-RES-9，架构 §1.2）。
 *
 * ## 什么是「旧数据」
 *
 * v0.9 之前投递上只有 `resumeVersion`（用户手输的一段文本），没有 `resumeVersionId`。
 * `aggregateByVersion` 把这类投递**全部**塞进 `key='legacy'` 的一个桶，标签固定是
 * 「未绑定（旧数据）」。三层后果里只有第一层被 v0.9 记进了发布说明：
 *
 * 1. 统计算不到任何一份简历头上（简历页的「投递 N · 进面 M」永远缺这些）；
 * 2. **`legacy` 是一个死桶 —— 只进不出。** 用户后来就算建了同名的版本、绑了 id，
 *    这条老投递也出不来：它没有任何出口。这比「统计不准」严重；
 * 3. `ListView` 会长期挂着一个幽灵筛选项，看着像分类，其实是「没救了」。
 *
 * 本文件只做**识别**：判定、取列表、按文本分组。归类的写库动作一律走
 * `resume/bind.ts` 的 `bindResumeVersion`（架构 B-05：全库唯一写 `resumeBindLog`
 * 的函数），这里绝不自己写库 —— 否则就是第二套「绑定」语义。
 *
 * ## 为什么不做「一键全归」
 *
 * 文本是手输的。「v3-前端-项目版」「v3」「V3」可能指同一份，也可能分别是
 * 「第三版」和「V3 公司专用版」。批量归类一旦错，是**全错且难以发现** ——
 * 统计看起来「变好了」，用户根本不会去核。这比不准更糟：不准至少是诚实的。
 * 所以本文件提供**分组信息**（让用户看出哪些文本看起来是同一个东西），
 * 但确认必须逐条。
 */

import type { Application, DB } from '../types';
import { isDeleted } from '../lib/trash';

/**
 * 一条投递是不是「旧数据」：**有手输文本、没有 id 绑定**。
 *
 * 只有文本为空 / 全空白的才算 `none`（未标注）—— 空字符串不是「旧数据」，
 * 它连当时写的什么都没留下，问了也答不出该归到哪一版。
 *
 * @param app 任意一条投递
 * @returns 是旧数据返回 true
 */
export function isLegacy(app: Application): boolean {
  if (app.resumeVersionId) return false;
  return (app.resumeVersion ?? '').trim().length > 0;
}

/**
 * 待归类的投递（**排除回收站里的**）。
 *
 * 为什么不问回收站里的：那是一批已经被用户决定要删掉的记录，让用户为它们
 * 逐个选版本是在加活；它们 30 天后就没了，归类对统计没有任何影响。
 *
 * 保持录入顺序（不重排）：用户逐条走的时候，直觉上的顺序就是「当时记下来的顺序」。
 *
 * @param db 当前库
 * @returns 待归类的投递（可能为空数组）
 */
export function legacyApplicationsOf(db: DB): Application[] {
  return db.applications.filter((app) => !isDeleted(app) && isLegacy(app));
}

/**
 * 待归类的条数。横幅 / 筛选项 / 弹层进度三处共用同一个口径。
 *
 * @param db 当前库
 * @returns 条数
 */
export function legacyCountOf(db: DB): number {
  return legacyApplicationsOf(db).length;
}

/** 按文本分组后的一组 */
export interface LegacyTextGroup {
  /** 用户当初手输的那串文本（已 trim） */
  text: string;
  /** 写的是这串文本的投递条数（至少 1） */
  count: number;
}

/**
 * 按手输文本分组，用来在归类面板上告诉用户「还有几条写的是同一个文本」。
 *
 * 这**只是提示，不是批量入口**：分组解决的是「我一眼看不出哪些是同一份」，
 * 不解决「替我判断它们是不是同一份」。后者必须由用户逐条确认（见文件头）。
 *
 * 排序：条数多的在前，同数按文本字典序 —— 让「最像一份简历的那批」先出现在视野里。
 *
 * @param apps 待归类的投递（`legacyApplicationsOf` 的结果）
 * @returns 分组列表（可能为空数组）
 */
export function legacyTextGroupsOf(apps: Application[]): LegacyTextGroup[] {
  const counter = new Map<string, number>();
  for (const app of apps) {
    const text = (app.resumeVersion ?? '').trim();
    if (!text) continue;
    counter.set(text, (counter.get(text) ?? 0) + 1);
  }
  return [...counter.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'zh-Hans-CN'));
}

/**
 * 从当前位置往后找下一条待处理的投递下标（到末尾回卷）。
 *
 * 归类成功后当前这条会从列表里消失（`resumeVersionId` 有值就不再是旧数据），
 * 所以调用方**不要**用它去算「下一条是谁」的下标，而要用它来找「下一个还需要的」。
 * 这里做成纯函数，是为了让「走到最后一条之后回到哪」这件小事有断言。
 *
 * @param total 剩余条数
 * @param from 当前下标（-1 = 还没开始）
 * @returns 下一个下标；`total === 0` 时返回 -1
 */
export function nextLegacyIndex(total: number, from: number): number {
  if (total <= 0) return -1;
  const next = from + 1;
  return next >= total ? 0 : next;
}
