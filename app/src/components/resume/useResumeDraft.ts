/**
 * 简历草稿的 React 绑定（12 行的壳，真正的逻辑在 `resume/draft.ts`）。
 *
 * 用法（T05 的 ResumeEditor、T07 的 AI 写回都靠这三个方法）：
 *   const { draft, update, flush } = useResumeDraft({ content: resume.content, onCommit });
 *   <SchemaForm sections={sections} content={draft} onChange={update} />
 * 表单本身是受控的（它只管「改哪个字段」，不持有整份内容），持有草稿的只有这个 hook。
 *
 * 三条语义，缺一条都会出隐蔽 bug：
 * 1. **外部内容变化以外部为准**：AI 写回 / 切模板 / 换了一份简历时，丢掉本地待提交的草稿。
 *    否则下一次防抖到点会用旧草稿把 AI 的写入盖掉（ARCH §7.7）。
 * 2. **卸载即落库**：切页 / 关抽屉 / 换视图都不该让最后 400 ms 白输。
 * 3. **onCommit 用 ref 转一手**：父组件每次渲染都可能传新的箭头函数，
 *    直接塞进 writer 会把待提交的值一起丢掉。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResumeContent } from '../../types';
import { createDraftWriter, DRAFT_DEBOUNCE_MS, type DraftWriter } from '../../resume/draft';

export interface ResumeDraftOptions {
  /** 库里的内容（外部真相：AI 写回、切模板、换简历都会换掉它） */
  content: ResumeContent;
  /** 落库通道：防抖窗口结束后调用一次（调用方接 `api.updateResumeContent`） */
  onCommit: (next: ResumeContent) => void;
  /** 测试注入用；默认 400 ms */
  delayMs?: number;
}

export interface ResumeDraftHandle {
  /** 正在编辑的草稿（预览直接用它渲染，不等落库） */
  draft: ResumeContent;
  update: (next: ResumeContent) => void;
  /** 立刻落库（AI 写回前、打印前、点「存为新版本」前都要调） */
  flush: () => void;
  /** 丢弃待提交的草稿（外部内容才是真相时） */
  cancel: () => void;
  /** 是否有还没落库的改动（用于「未保存」提示） */
  pending: () => boolean;
}

export function useResumeDraft(options: ResumeDraftOptions): ResumeDraftHandle {
  const { content, onCommit, delayMs = DRAFT_DEBOUNCE_MS } = options;
  const [draft, setDraft] = useState<ResumeContent>(content);

  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const writerRef = useRef<DraftWriter<ResumeContent> | null>(null);
  if (!writerRef.current) {
    writerRef.current = createDraftWriter<ResumeContent>((next) => commitRef.current(next), delayMs);
  }

  /** 上一次由外部给进来的内容：用来区分「外部改了」与「我们自己刚提交完」 */
  const sourceRef = useRef(content);

  useEffect(() => {
    const writer = writerRef.current;
    return () => {
      // 卸载即落库：最后 400 ms 的输入不能丢
      writer?.flush();
    };
  }, []);

  useEffect(() => {
    if (content === sourceRef.current) return;
    sourceRef.current = content;
    writerRef.current?.cancel();
    setDraft(content);
  }, [content]);

  const update = useCallback((next: ResumeContent) => {
    setDraft(next);
    writerRef.current?.schedule(next);
  }, []);

  const flush = useCallback(() => {
    writerRef.current?.flush();
  }, []);

  const cancel = useCallback(() => {
    writerRef.current?.cancel();
  }, []);

  const pending = useCallback(() => writerRef.current?.pending() ?? false, []);

  return { draft, update, flush, cancel, pending };
}
