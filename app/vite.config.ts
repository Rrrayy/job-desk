import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 版本号只有一个来源：package.json。构建期注入 __APP_VERSION__，
// 保证「设置页显示的版本」和「发版打的 tag」不会各说各话。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

// 目标：npm run build 后 dist/index.html 是一个自包含的单文件，
// 双击用浏览器打开（file:// 协议）即可使用，不依赖任何外部 js/css。
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2018',
    outDir: 'dist',
    assetsDir: 'assets',
    cssCodeSplit: false,
    // cssCodeSplit:false 时 vite 会把 CSS 原样交给 singlefile 插件，**不做压缩**。
    // 单文件产物的体积直接等于用户下载量，所以这里显式打开。
    // 用 esbuild 而不是 lightningcss：后者要额外装包，而本项目的
    // 「构建链不加依赖」是写进 README 的承诺；esbuild 本来就是 vite 的传递依赖。
    cssMinify: 'esbuild',
    assetsInlineLimit: 100 * 1024 * 1024,
    reportCompressedSize: false,
  },
});
