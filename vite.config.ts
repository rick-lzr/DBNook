import { defineConfig } from 'vite';
export default defineConfig({
  root: 'packages/webview',
  server: { host: '127.0.0.1' },
  build: { outDir: '../../dist/webview', emptyOutDir: true, cssCodeSplit: false,
    rollupOptions: { input: 'packages/webview/src/main.tsx', output: { entryFileNames: 'app.js', assetFileNames: 'app.[ext]' } } },
});
