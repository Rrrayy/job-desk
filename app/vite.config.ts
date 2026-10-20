import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 目标：npm run build 后 dist/index.html 是一个自包含的单文件，
// 双击用浏览器打开（file:// 协议）即可使用，不依赖任何外部 js/css。
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    target: 'es2018',
    outDir: 'dist',
    assetsDir: 'assets',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    reportCompressedSize: false,
  },
});
