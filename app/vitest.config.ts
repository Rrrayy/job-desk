import { defineConfig } from 'vitest/config';

/**
 * 测试配置独立于 vite.config.ts。
 * 理由（架构 D-04）：把 test 字段塞进 vite.config.ts 会污染 defineConfig 的类型，
 * 而 vitest 只需要一个纯 node 环境跑纯函数测试 —— 不需要 jsdom、不需要 React 插件。
 *
 * 临时目录的重定向放在 scripts/run-tests.mjs 里做（libuv 会缓存 os.tmpdir()，
 * 在配置文件里改环境变量来不及）。
 */
export default defineConfig({
  cacheDir: 'node_modules/.vite-test',
  test: {
    environment: 'node',
    // v0.9.1 修订：include 原来只有 `src/**`，导致 `scripts/check-no-network.test.mjs`
    // （v0.8 T03 写的门禁自测）**从未被执行过** —— 写了测试但没接进 runner，
    // 等于没有测试。这里把 `scripts/**/*.test.mjs` 一并纳入（门禁脚本也是产品的一部分，
    // 它的自测必须真的跑）。三个门禁脚本自测都是纯 node，不碰 jsdom。
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    // v0.5.1 起组件测试破例引入 jsdom（用户拍板）：默认仍是 node（D-04 不变），
    // 需要组件环境的测试文件在第一行写 `// @vitest-environment jsdom`
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    reporters: ['default'],
    // fixtures 是纯文本，测试里用 fs 直接读，不走 vite 的静态资源管线
  },
});
