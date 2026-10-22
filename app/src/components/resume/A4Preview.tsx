/**
 * A4 预览画布（ARCH §1.4）。
 *
 * 唯一的强保证：**预览与打印是同一份 DOM 的不同「透视」**。
 * 尺寸一律 mm（打印就是物理尺寸），缩放只在外层套一个 `transform: scale()` 的壳。
 * 绝不用 `zoom`（它改布局盒、Firefox 支持不全、在打印路径上行为不一致），
 * 也绝不写「预览一套 px / 打印一套 mm」—— 两套真相迟早漂移。
 *
 * 为什么缩放值走 CSS 变量、不进 React state：`ResizeObserver` 每帧都可能触发，
 * 进 state 就是每帧一次 React 提交；写 `style.setProperty` 只触发样式重算。
 * 唯一进 state 的是「几页」，因为它决定要不要多渲染几个分页标（DOM 结构变了）。
 *
 * 无障碍：`.a4` 标 `aria-hidden`（ARCH §7.5）—— 同一份内容在左侧表单里已有可访问表达，
 * 屏幕阅读器不该读两遍；`aria-hidden` 不影响打印。
 */

import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ResumeContent, ResumeItem, TemplateSectionSpec, TemplateId } from '../../types';
import { cleanBullets, parseTags } from '../../resume/schema';
import { SECTION_LABEL, fieldMetaOf } from '../../resume/templates/base';
import { PAGE_CONTENT_PX, PAGE_MARGIN_PX, pageCountOf, pageTopPx } from '../../resume/print';
import { sectionsOf, templateOf } from '../../resume/templates';
import { cx } from '../../lib/util';

/** A4 宽度（mm）：210 × 96/25.4 ≈ 793.7px，缩放比例的基准 */
export const A4_WIDTH_PX = (210 * 96) / 25.4;
/** A4 高度（mm）：297 × 96/25.4 ≈ 1122.5px —— 内容再短，纸也不会短于这个高度 */
export const A4_HEIGHT_PX = (297 * 96) / 25.4;
/** 缩放下限（再小就不可读；PRD Q10 已否决「一页模式自动缩字号」） */
export const A4_MIN_SCALE = 0.35;

export interface A4PreviewProps {
  content: ResumeContent;
  templateId: TemplateId;
  /** 固定缩放（测试 / 快照用）；不传则由容器宽度算出 */
  scale?: number;
}

/** 把「可用宽度 / A4 宽度」夹到可读区间，保留两位（避免每帧都算出微小差异） */
export function clampScale(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(1, Math.max(A4_MIN_SCALE, Math.round(raw * 100) / 100));
}

/**
 * 可用宽度 = **父容器**的内容宽（扣掉左右内边距）。
 *
 * 为什么不能量 `.a4-fit` 自己：它的 width 就是 `210mm × var(--a4-scale)` ——
 * 量自己会闭合成不动点（窗口不管多窄都算回原来那个 scale，永远不会缩小）。
 * 量父容器才拿得到「这一列到底有多宽」这个外部事实。
 *
 * 量不到（没有父容器 / jsdom 里 clientWidth 恒为 0）→ 返回 A4 原宽，
 * 于是 clampScale 落回 1：预览按原尺寸显示，而不是缩成一个没法读的小方块。
 */
function availableWidthOf(host: HTMLElement): number {
  const parent = host.parentElement;
  if (!parent || parent.clientWidth <= 0) return A4_WIDTH_PX;
  const style = getComputedStyle(parent);
  const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const avail = parent.clientWidth - padX;
  return avail > 0 ? avail : A4_WIDTH_PX;
}

function A4PreviewInner({ content, templateId, scale }: A4PreviewProps) {
  const sections = sectionsOf(templateId);
  const layout = templateOf(templateId)?.layout ?? 'single';
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState(1);

  /* 缩放：只写 CSS 变量，不进 state。观察父容器（窗口/分栏变化）而不是自己 */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || scale !== undefined) return;
    const apply = (): void => {
      host.style.setProperty('--a4-scale', String(clampScale(availableWidthOf(host) / A4_WIDTH_PX)));
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(host.parentElement ?? host);
    return () => observer.disconnect();
  }, [scale]);

  /* 页数：决定要不要多渲染分页标，只能进 state；但只在数字变了时才提交 */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = (): void => {
      const rect = body.getBoundingClientRect();
      const style = getComputedStyle(body);
      // ★ 页数要按**内容高度**算：`.a4__body` 的 14mm 上下内边距就是纸的上下边距，
      // 不属于内容。直接拿 border-box 高度会 297mm/269mm=1.1 —— 正好一页的内容被算成两页。
      const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      const contentHeight = rect.height - padY;
      // 宿主高度按整张纸算（内容不足一页时也不能短于 297mm）
      hostRef.current?.style.setProperty('--a4-h', `${Math.max(rect.height, A4_HEIGHT_PX)}px`);
      const next = pageCountOf(contentHeight);
      setPages((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [content]);

  const style = scale === undefined ? undefined : ({ '--a4-scale': String(clampScale(scale)) } as CSSProperties);

  return (
    <div className="a4-fit" ref={hostRef} style={style} data-pages={pages}>
      <div className={cx('a4', `a4--${layout}`)} aria-hidden="true">
        <div className="a4__body" ref={bodyRef}>
          {sections.map((spec) => {
            const section = content.sections.find((item) => item.type === spec.type);
            if (!section) return null;
            const visible = section.items.filter((item) => itemHasContent(spec, item));
            // 整块空白（连必填占位都没有）就不占版面：空板块的标题只会让简历看起来像没写完
            if (visible.length === 0) return null;
            const title = section.title?.trim() || spec.label || SECTION_LABEL[spec.type];
            return (
              <section className="rs-section" key={section.id}>
                <h3 className="rs-section__title">{title}</h3>
                {visible.map((item) => (
                  <ResumeItemBlock key={item.id} spec={spec} item={item} />
                ))}
              </section>
            );
          })}
        </div>
        {/* 分页标：屏幕上的辅助线/页码，打印时整类消失（@media print） */}
        {Array.from({ length: pages }, (_, index) => (
          <span
            className="a4__page-no"
            key={`p${index}`}
            style={{ top: `${pageTopPx(index) + PAGE_CONTENT_PX - PAGE_MARGIN_PX}px` }}
          >
            {index + 1}
          </span>
        ))}
        {/* 分页线画在「第 i+1 页内容起点」，与打印时的真实断开位置一致 */}
        {Array.from({ length: Math.max(0, pages - 1) }, (_, index) => (
          <span className="a4__guide" key={`g${index}`} style={{ top: `${pageTopPx(index + 1)}px` }} />
        ))}
      </div>
    </div>
  );
}

/** 一个条目在纸上有没有任何可见内容（必填未填也算：要让它占位可见） */
function itemHasContent(spec: TemplateSectionSpec, item: ResumeItem): boolean {
  for (const field of spec.fields) {
    const meta = fieldMetaOf(field);
    if (meta.type === 'rich_bullets') {
      if (cleanBullets(item.bullets).length > 0) return true;
    } else if ((item.fields[meta.key] ?? '').trim()) {
      return true;
    }
    if (meta.required) return true;
  }
  return false;
}

function ResumeItemBlock({ spec, item }: { spec: TemplateSectionSpec; item: ResumeItem }) {
  const metas = spec.fields.map(fieldMetaOf);
  const valueOf = (key: string): string => (item.fields[key] ?? '').trim();

  // 首行 = 第一个有值的文本字段 + 起止月份（简历的通用读法；具体版式由 T04 的 layout 接管）
  const primary = metas.find((meta) => meta.type === 'text' && valueOf(meta.key));
  const start = valueOf('startMonth');
  const end = valueOf('endMonth');
  const period = start || end ? `${start || '—'} – ${end || '至今'}` : '';
  const rest = metas.filter(
    (meta) => meta.key !== primary?.key && meta.key !== 'startMonth' && meta.key !== 'endMonth',
  );

  const missing: string[] = [];
  const firstRequired = metas.find((meta) => meta.required);
  if (firstRequired && (firstRequired.type === 'rich_bullets'
    ? cleanBullets(item.bullets).length === 0
    : valueOf(firstRequired.key) === '')) {
    // 首行那个字段空了，标题位就是它的占位
    if (!primary) missing.push(firstRequired.label);
  }
  for (const meta of rest) {
    if (!meta.required) continue;
    const filled = meta.type === 'rich_bullets' ? cleanBullets(item.bullets).length > 0 : valueOf(meta.key) !== '';
    if (!filled) missing.push(meta.label);
  }

  return (
    <div className="rs-item">
      {primary || period ? (
        <div className="rs-item__head">
          {primary ? <span className="rs-item__title">{valueOf(primary.key)}</span> : null}
          {period ? <span className="rs-item__period">{period}</span> : null}
        </div>
      ) : null}

      {rest.map((meta) => {
        if (meta.type === 'image') return null; // 照片随 creative（T04）：本版预览不渲染
        if (meta.type === 'rich_bullets') {
          const bullets = cleanBullets(item.bullets);
          if (bullets.length === 0) return null;
          return (
            <ul className="rs-list" key={meta.key}>
              {bullets.map((line, index) => (
                <li className="rs-bullets" key={`${meta.key}-${index}`}>
                  {line}
                </li>
              ))}
            </ul>
          );
        }
        const raw = valueOf(meta.key);
        if (!raw) return null;
        const text = meta.type === 'tags' ? parseTags(raw).join(' · ') : raw;
        return (
          <p className={cx('rs-item__line', meta.type === 'tags' && 'rs-item__tags')} key={meta.key}>
            {text}
          </p>
        );
      })}

      {missing.length > 0 ? <p className="rs-placeholder">未填：{missing.join('、')}</p> : null}
    </div>
  );
}

/** 只在 content 引用变化时重渲：编辑期每秒几十次 onChange，A4 子树不该跟着跑 */
export const A4Preview = memo(A4PreviewInner);
