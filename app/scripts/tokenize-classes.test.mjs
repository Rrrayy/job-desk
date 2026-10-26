/**
 * 类名 token 化脚本的自测（v0.9.1 T1-a，架构 B-03 / §6.3）。
 *
 * 这一层测的是**扫描器口径**与**表分配规则**——也就是「不能被普通测试覆盖的部分」：
 * 全量 948 项测试证明的是「DOM 输出没变」，但它们证明不了「扫描器有没有漏掉某类写法」。
 * 一旦扫描器口径漂了（比如开始改模板串），DOM 就会变，而那时测试红的位置
 * 离真正的原因（脚本）很远。所以脚本自身必须有断言。
 *
 * 特别注意第 3 组：**含 `${` 的模板串一律不许碰**。这是把动态类名家族
 * （`stars--${n}` / `qb__mastery--${n}` / `a4--${layout}` …）的风险面归零的那条约束，
 * 破了它 T1 就会变成「改完样式全乱」。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ENTRIES,
  cssAtoms,
  decodeLiteral,
  findMatching,
  lex,
  netGain,
  planTable,
  readTable,
  renderTable,
  rewriteFile,
  runCheck,
  scanOccurrences,
  splitArgs,
  tokenNames,
  trimSpan,
} from './tokenize-classes.mjs';

describe('tokenize-classes · 词法层', () => {
  it('lex 遮住注释，但保留常规字符串字面量（引号与内容都要能定位）', () => {
    const src = "// className=\"hidden\"\nconst a = 'btn';\n/* className=\"x\" */";
    const { code, strings } = lex(src);
    expect(code).not.toContain('hidden');
    expect(code).not.toContain('/*');
    expect(strings.map((s) => s.value)).toEqual(['btn']);
    // 遮罩不改变长度：偏移才能直接用来改写
    expect(code).toHaveLength(src.length);
  });

  it('lex 把模板串的字面量片段遮掉，但 `${…}` 里的表达式保持可读', () => {
    const src = 'const c = `qb__group ${open ? FLAG : 0}`;';
    const { code } = lex(src);
    expect(code).not.toContain('qb__group');
    expect(code).toContain('open');
    expect(code).toHaveLength(src.length);
  });

  it('decodeLiteral 只解本仓会用的转义', () => {
    expect(decodeLiteral('a\\nb')).toBe('a\nb');
    expect(decodeLiteral("it\\'s")).toBe("it's");
    expect(decodeLiteral('plain')).toBe('plain');
  });
});

describe('tokenize-classes · 括号与参数切分', () => {
  it('findMatching 跨嵌套括号找到匹配的右括号', () => {
    const code = "cx('a', f(g(1), [2]), cond ? 'b' : 'c')";
    const open = code.indexOf('(');
    expect(findMatching(code, open)).toBe(code.length - 1);
  });

  it('splitArgs 只在顶层逗号切分（嵌套调用 / 数组 / 三元都不切）', () => {
    const code = "cx('a', f(1, 2), cond ? 'b' : 'c', 'd')";
    const open = code.indexOf('(');
    const close = findMatching(code, open);
    const spans = splitArgs(code, open + 1, close);
    expect(spans).toHaveLength(4);
    expect(code.slice(...spans[0]).trim()).toBe("'a'");
    expect(code.slice(...spans[3]).trim()).toBe("'d'");
  });

  it('trimSpan 对全空白返回 null', () => {
    expect(trimSpan('   ', 0, 3)).toBeNull();
    expect(trimSpan('  x ', 0, 4)).toEqual([2, 3]);
  });
});

describe('tokenize-classes · 扫描口径（这是风险面）', () => {
  it('识别三种纯字面量形态：className="V" / className={"V"} / cx 的纯字面量参数', () => {
    const src = [
      '<div className="btn btn--small" />',
      "<span className={'field__label'} />",
      "cx('muted', cond && 'field__hint')",
    ].join('\n');
    const values = scanOccurrences(src).map((o) => o.value);
    // `cond && 'field__hint'` 是 `&&` 表达式而不是纯字面量 —— 刻意不碰（同模板串约束）
    expect(values).toEqual(['btn btn--small', 'field__label', 'muted']);
  });

  it('★ 含 `${` 的模板串一律不碰（动态类名家族的归零约束）', () => {
    const src = [
      '<span className={`stars stars--${n}`} />',
      '<span className={`qb__mastery qb__mastery--${q.mastery}`} />',
      '<li className={`sync__row--${row.kind}`} />',
      'cx(`a4--${layout}`)',
    ].join('\n');
    expect(scanOccurrences(src)).toHaveLength(0);
  });

  it('★ 变量 / 三元 / 拼接 / 调用表达式一律不碰（只做纯字面量）', () => {
    const src = [
      '<div className={styles.box} />',
      "<div className={cond ? 'btn' : 'btn btn--primary'} />",
      "<div className={base + ' btn'} />",
      '<div className={cx(maybe)} />',
    ].join('\n');
    // 第三行里的 ' btn' 在 `+` 右侧，不是 className 的字面量整体，也不算 cx 参数
    expect(scanOccurrences(src)).toHaveLength(0);
  });

  it('注释里出现的 className 不算数', () => {
    const src = '// <div className="btn btn--small" />\nconst x = 1;';
    expect(scanOccurrences(src)).toHaveLength(0);
  });

  it('改写后重复扫描不再命中（幂等）', () => {
    const src = '<div className="btn btn--small">x</div>';
    const tokenByValue = new Map([['btn btn--small', 'a']]);
    const { next, changed } = rewriteFile(src, tokenByValue);
    expect(changed).toBe(1);
    expect(next).toBe('<div className={CLS.a}>x</div>');
    expect(scanOccurrences(next)).toHaveLength(0);
  });
});

describe('tokenize-classes · 表分配规则', () => {
  it('tokenNames：前 52 个是 1 字符，第 53 个起是 2 字符且不重复', () => {
    const names = tokenNames(100);
    expect(names).toHaveLength(100);
    expect(new Set(names).size).toBe(100);
    expect(names[0]).toBe('a');
    expect(names[51]).toHaveLength(1);
    expect(names[52]).toHaveLength(2);
    for (const n of names) expect(n).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
  });

  it('netGain 随出现次数线性增长，短 token 优于长 token', () => {
    const value = 'btn btn--small';
    expect(netGain(value, 10, 2)).toBeGreaterThan(netGain(value, 5, 2));
    expect(netGain(value, 10, 1)).toBeGreaterThan(netGain(value, 10, 2));
  });

  it('★ planTable 截断到 MAX_ENTRIES，且高频串拿短号（收益最大化）', () => {
    const counts = new Map();
    for (let i = 0; i < 150; i += 1) {
      // 频次递减，长串足够长以保证收益为正
      counts.set(`some-class-name--${i}`, 200 - i);
    }
    const plan = planTable(counts);
    expect(plan).toHaveLength(MAX_ENTRIES);
    // 频次最高的拿 1 字符 token
    expect(plan[0].token).toHaveLength(1);
    expect(plan[0].count).toBe(200);
    // 频次降序
    for (let i = 1; i < plan.length; i += 1) {
      expect(plan[i].count).toBeLessThanOrEqual(plan[i - 1].count);
    }
  });

  it('planTable 对同一输入完全确定（`--check` 的一致性断言依赖这点）', () => {
    const counts = new Map([
      ['btn btn--small', 76],
      ['field__label', 75],
      ['muted', 55],
    ]);
    expect(planTable(counts)).toEqual(planTable(new Map(counts)));
  });

  it('planTable 丢掉零次出现的串（防止幽灵条目占额度）', () => {
    const counts = new Map([
      ['btn btn--small', 10],
      ['ghost-class-that-never-appears', 0],
    ]);
    expect(planTable(counts).map((e) => e.value)).toEqual(['btn btn--small']);
  });

  it('renderTable / readTable round-trip', () => {
    const entries = [
      { token: 'a', value: 'btn btn--small' },
      { token: 'b', value: 'field__label' },
    ];
    expect(readTable('/definitely/not/a/file.ts')).toBeNull();
    const rendered = renderTable(entries);
    expect(rendered).toContain("a: 'btn btn--small',");
    expect(rendered).toContain('勿手改');
    expect(rendered).toContain('as const');
  });
});

describe('tokenize-classes · 仓库现状（门禁口径）', () => {
  it('★ `--check` 的五条断言全过（漏网 / round-trip / 无重复 / ≤100 / 选表一致）', () => {
    const { ok, lines } = runCheck();
    if (!ok) console.error(lines.join('\n'));
    expect(ok).toBe(true);
  });

  it('★ 表条目数不超过 B-02 的硬上限 100（全量做会把 −9.48 KB 掉到 −3.09 KB）', () => {
    const table = readTable();
    expect(table).not.toBeNull();
    expect((table ?? []).length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect((table ?? []).length).toBeGreaterThan(0);
  });

  it('★ 表里没有重复 key、没有重复 value（重复 value = 统计口径错了）', () => {
    const table = readTable() ?? [];
    expect(new Set(table.map((e) => e.token)).size).toBe(table.length);
    expect(new Set(table.map((e) => e.value)).size).toBe(table.length);
  });

  it('cssAtoms 能从 CSS 里抽出类名原子（round-trip 断言的基础）', () => {
    const atoms = cssAtoms('.btn { } .btn--small{ } .a .b-c:hover { }');
    expect(atoms.has('btn')).toBe(true);
    expect(atoms.has('btn--small')).toBe(true);
    expect(atoms.has('b-c')).toBe(true);
  });
});
