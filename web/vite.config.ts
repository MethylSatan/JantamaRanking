// 画面のビルド（タスク 026）。root は web/、出力は dist/web/。
// 手元の開発（npm run dev）では /api と /rankings を本番に向ける（docs/deploy.md「手元の開発」）
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: new URL('./admin.html', import.meta.url).pathname,
        ranking: new URL('./ranking.html', import.meta.url).pathname,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'https://jantama-ranking.methylsatan.com', changeOrigin: true },
      // 閲覧の画面（ranking.html）が読むランキングの JSON
      '/rankings': { target: 'https://jantama-ranking.methylsatan.com', changeOrigin: true },
    },
  },
});
