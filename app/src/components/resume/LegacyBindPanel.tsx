/**
 * 旧数据归类面板（v0.9.1 / R-RES-9，架构 §1.2）。
 *
 * ## 一个面板，两个入口
 *
 * - **主动入口**：简历页列表态顶部横幅「有 N 条投递是 v0.9 之前记的…[逐条归类]」
 * - **被动入口**：列表页选中「未绑定（旧数据）」筛选项时，表头右侧的「逐条归类」
 *
 * 两个入口挂的是**同一个组件、同一个弹层**（不写第二套），这样「归类」只有一份实现，
 * 也就只有一份口径。
 *
 * ## 四个出口，都不静默
 *
 * | 出口 | 语义 | 落库 |
 * | --- | --- | --- |
 * | 「归到这一版」 | 归类 | 走 `api.bindResumeVersion`（全库唯一写 `resumeBindLog` 的函数） |
 * | 「跳过（暂不归类）」 | 这次不表态，下次进来还在 | 不写 |
 * | 「不属于任何版本」 | 明确表态「当时确实没用库里的版本」 | **不写**（见下） |
 * | 关闭 / Esc | 已处理的不再出现 | 不写 |
 *
 * ## 为什么「不属于任何版本」不落库字段
 *
 * 想记住「这条我确认过不属于任何版本」需要一个标记字段 —— 那要改 schema，
 * 而 v0.9.1 是**零 schema 变更版本**（架构 B-01）。所以它的行为等同「跳过」，
 * 只是文案把意思说清楚了。代价是下次打开还会问；可接受，因为逐条归类是一次性的活，
 * 走完之后 `legacyApplicationsOf` 就空了（归类后 `resumeVersionId` 有值 → 自动出列，
 * **不需要任何「已处理」标记字段** —— 又一处零 schema 的收益）。
 *
 * ## 为什么不提供「一键全归」
 *
 * 见 `resume/legacy.ts` 文件头：手输文本的「同不同」只有用户知道，批量错了是全错且难发现。
 * 本面板会告诉用户「另有 N 条写的是同一个文本」（分组信息），但确认必须一条一条。
 */

import { useEffect, useMemo, useState } from 'react';
import type { AppApi } from '../../lib/api';
import type { Application } from '../../types';
import { isDeleted } from '../../lib/trash';
import { companyLabel } from '../../lib/util';
import { CLS } from '../../lib/classTokens';
import { STATUS_LABEL } from '../../lib/rules';
import { fmtDate } from '../../lib/date';
import { legacyApplicationsOf, legacyTextGroupsOf } from '../../resume/legacy';

/** 一个可选的候选版本（跨全部活着的简历） */
interface Candidate {
  id: string;
  label: string;
}

export interface LegacyBindPanelProps {
  api: AppApi;
  onClose: () => void;
}

export function LegacyBindPanel({ api, onClose }: LegacyBindPanelProps) {
  /**
   * 队列在**打开时快照一次**。不随 `api.db` 实时重算的理由：
   * 归类成功后这条投递会从 `legacyApplicationsOf` 里消失，实时重算会让下标整体前移，
   * 用户点「归到这一版」之后看到的是**下一批里的第 N 条**，进度也不再单调。
   * 快照里存的对象只用来显示公司/岗位/文本，这些字段归类不会改，不存在显示过期。
   */
  const [queue] = useState<Application[]>(() => legacyApplicationsOf(api.db));
  const [index, setIndex] = useState(0);
  const [pick, setPick] = useState('');
  const [done, setDone] = useState(0);

  const total = queue.length;
  const current = index >= 0 && index < total ? queue[index] : null;

  /** 候选版本：只出活版本，且所属简历也活着（与 `bindResumeVersion` 的拒绝口径一致） */
  const candidates = useMemo<Candidate[]>(() => {
    const db = api.db;
    const aliveResumes = new Map(db.resumes.filter((item) => !isDeleted(item)).map((item) => [item.id, item]));
    const rows: Array<Candidate & { resumeName: string }> = [];
    for (const version of db.resumeVersions) {
      if (isDeleted(version)) continue;
      const resume = aliveResumes.get(version.resumeId);
      if (!resume) continue;
      rows.push({ id: version.id, label: version.label, resumeName: resume.name });
    }
    const multiResume = aliveResumes.size > 1;
    return rows
      .sort(
        (a, b) =>
          a.resumeName.localeCompare(b.resumeName, 'zh-Hans-CN') ||
          a.label.localeCompare(b.label, 'zh-Hans-CN'),
      )
      .map((row) => ({ id: row.id, label: multiResume ? `${row.resumeName} · ${row.label}` : row.label }));
  }, [api.db]);

  /** 当前这条的文本分组信息：「另有 N 条写的是同一个文本」 */
  const siblingCount = useMemo(() => {
    if (!current) return 0;
    const text = (current.resumeVersion ?? '').trim();
    const group = legacyTextGroupsOf(queue).find((item) => item.text === text);
    return group ? group.count : 1;
  }, [current, queue]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /**
   * 收尾：关面板并报「这次归了几条」。
   *
   * `extra` 是「刚归完的这一条」—— 不能读 `done` 的 state，因为 `setDone` 之后
   * 同一个渲染帧里 `done` 还是旧值（闭包快照），会导致最后一条永远不报数。
   */
  const finish = (extra: number): void => {
    onClose();
    const bound = done + extra;
    if (bound > 0) api.toast(`旧数据归类完成：这次归了 ${bound} 条`);
  };

  const step = (): void => {
    setPick('');
    if (index + 1 >= total) {
      finish(0);
      return;
    }
    setIndex(index + 1);
  };

  const confirm = (): void => {
    if (!current || !pick) return;
    // 归类走的是改绑那条唯一通道：写法绑定 / 留痕 / 不写 note 全部自动继承（B-05）
    if (!api.bindResumeVersion(current.id, pick)) {
      api.toast('这一版已经绑不上了（可能刚被删），换一版或跳过');
      return;
    }
    setDone(done + 1);
    setPick('');
    if (index + 1 >= total) {
      finish(1);
      return;
    }
    setIndex(index + 1);
  };

  const pickedLabel = candidates.find((item) => item.id === pick)?.label ?? '';

  return (
    <div className={CLS.U} onClick={onClose}>
      <div
        className="modal legacy-bind"
        role="dialog"
        aria-modal="true"
        aria-labelledby="legacy-bind-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={CLS.ac}>
          <h2 className={CLS.Y} id="legacy-bind-title">
            旧数据归类
          </h2>
          <span className="legacy-bind__progress" aria-live="polite">
            {total === 0 ? '已全部完成' : `${Math.min(index + 1, total)} / ${total}`}
          </span>
          <button type="button" className={CLS.m} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className={CLS.aa}>
          {current === null ? (
            <p className={CLS.c}>
              没有待归类的旧数据了 —— 统计已经能把它们算到对应的简历上。
            </p>
          ) : (
            <>
              <p className={CLS.c}>
                这些是 v0.9 之前记的投递，只有手输的简历文本、没绑版本 —— 统一算在
                「未绑定（旧数据）」里，统计到不了任何一份简历头上。挑出当时投的是哪一版，统计就准了。
              </p>

              <div className="legacy-bind__card">
                <strong>
                  {companyLabel(api.db.companies, current.companyId)} · {current.jobTitle}
                </strong>
                <div className={CLS.c}>
                  {fmtDate(current.appliedAt)} 投递 · 当前状态 {STATUS_LABEL[current.status]}
                </div>
                <div className="legacy-bind__text">
                  简历文本：「{current.resumeVersion}」
                </div>
                {siblingCount > 1 ? (
                  <div className={CLS.c}>
                    另有 {siblingCount - 1} 条写的是同一个文本（各自确认，不替你一起改）
                  </div>
                ) : null}
              </div>

              <label className={CLS.g}>
                <span className={CLS.a}>这份投的是哪一版？</span>
                <select
                  className={CLS.D}
                  value={pick}
                  aria-label="选择这一条投递对应的简历版本"
                  onChange={(event) => setPick(event.target.value)}
                >
                  <option value="">— 请选择 —</option>
                  {candidates.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              {pickedLabel ? (
                <p className={CLS.c}>
                  归类后简历列显示为「{pickedLabel}」（原文本「{current.resumeVersion}」不再显示）。
                  投递 / 沟通 / 面试记录都不动，沉默天数也不会被重置。
                </p>
              ) : candidates.length === 0 ? (
                <p className={CLS.s}>
                  库里还没有任何版本可以绑。先到简历页「存为新版本」，再回来归类。
                </p>
              ) : null}
            </>
          )}
        </div>

        <footer className={CLS.ab}>
          {current === null ? (
            <button type="button" className={CLS.j} onClick={onClose}>
              知道了
            </button>
          ) : (
            <>
              <button type="button" className={CLS.Q} onClick={step}>
                跳过（暂不归类）
              </button>
              <button type="button" className={CLS.Q} onClick={step}>
                不属于任何版本
              </button>
              <button
                type="button"
                className={CLS.j}
                onClick={confirm}
                disabled={!pick}
              >
                归到这一版
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
