/**
 * ESLint 扁平配置（v0.5.1 引入）。
 *
 * 严格度的取舍：**拦「真会出事」的，不拦「不好看」的**。
 *
 * 这个项目已经有 tsc --noEmit（类型）、vitest（行为）、check:no-network（零网络承诺）、
 * check:bundle（体积红线）。ESLint 如果再加一堆排版规则，只会让人为了空格去打
 * eslint-disable，把真问题淹掉。所以这里只放三类：
 *
 * 1. correctness —— 未定义变量、重复分支、只在字面量里比较、case 声明……
 *    这些是 tsc 抓不到（或抓到了但报错位置离现场很远）的真 bug。
 * 2. hooks —— React hooks 的依赖数组与调用顺序。这个项目大量使用 useCallback/useEffect，
 *    漏依赖是「看起来能跑、偶尔不更新」的经典来源。
 * 3. project —— 项目自己的边界：adapters 只许纯函数、lib 不许 import React。
 *    这两条是架构文档里写死的（D-02 / D-05），原来靠 code review，现在交给机器。
 *
 * 明确**不**启用：格式类（indent/quotes/semi）、复杂度类（max-lines/max-depth）、
 * exhaustive-deps 的报错（这个项目的 effect 有意跳过依赖，见 App.tsx 的注释，
 * 报错会逼人写一堆 eslint-disable；降为 warn 只在本地提示）。
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'coverage/**',
      'shots-*/**',
      'smoke-*/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    // TS 项目关掉 no-undef：类型系统已经覆盖，且 import type / 全局注入（__APP_VERSION__）会误报
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // 只保留 hooks 经典两条；v7 自带的 Compiler 级规则（refs/purity/immutability/
      // set-state-in-effect/preserve-manual-memoization）对这个代码库误报过多，不启用
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // —— correctness（default 里没有、但真的会咬人的）——
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-fallthrough': 'error',
      'no-unreachable-loop': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'require-atomic-updates': 'off', // 这个项目没有并发写状态，误报率高

      // —— typescript 侧：允许 _ 前缀显式表达「有意不用」——
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off', // 这个项目用 ! 的地方都有前置校验
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
    },
  },
  {
    // 架构边界（D-02 / D-05）：适配器只做解析，不许碰 React / storage / 全局状态
    files: ['src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'react/*'], message: '适配器必须与 UI 无关（架构 D-02）' },
            { group: ['../lib/storage*', '**/lib/storage*'], message: '适配器不碰存储（架构 D-02）' },
            { group: ['../lib/sync/*', '**/lib/sync/*'], message: '状态映射属于 lib/sync，不属于适配器（架构 D-02）' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'document', message: '适配器只吃字符串，不读 DOM（架构 D-02）' },
        { name: 'window', message: '适配器只吃字符串，不读 DOM（架构 D-02）' },
        { name: 'fetch', message: '适配器不发请求（零网络承诺）' },
      ],
    },
  },
  {
    // lib 层不硬禁 React：virtual.ts 这类文件只 import type（node 测试不受影响），
    // no-restricted-imports 分不出 type/value，交由 consistent-type-imports 保证
  },
  {
    // 构建脚本：node 环境
    files: ['scripts/**/*.mjs', '*.mjs', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // 测试与脚本：可以放宽
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**/*.mjs', '*.mjs', '*.config.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': 'off',
    },
  },
);
