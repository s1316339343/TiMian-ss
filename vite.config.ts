import { defineConfig } from 'vite';

// 使用相对路径，保证部署在 https://<user>.github.io/<repo>/ 这类子路径下也能正常加载资源。
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1600,
  },
});
