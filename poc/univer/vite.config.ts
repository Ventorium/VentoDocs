import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// POC 验证页：固定端口，便于脚本化无头访问
export default defineConfig({
  plugins: [react()],
  server: { port: 5199, host: '127.0.0.1', strictPort: true },
});
