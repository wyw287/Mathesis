import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 相对路径构建:产物可以直接丢进任意静态托管,或用 file:// 打开
  base: './',
  build: { target: 'es2022' },
});
