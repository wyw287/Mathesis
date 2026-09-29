import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 相对路径构建:产物可以直接丢进任意静态托管,或用 file:// 打开
  base: './',
  build: { target: 'es2022' },
  worker: {
    // 默认是 iife,而 iife 不支持代码分割 —— 核对用的 worker 会拉进整个
    // nerdamer(近 700 KB),必须让它单独成块,所以要用 es 格式。
    format: 'es',
  },
});
