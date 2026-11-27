import { defineConfig } from 'vite';
import exportPlugin from './server/exportPlugin.js';

export default defineConfig({
  plugins: [exportPlugin()],
  server: { port: Number(process.env.FW_PORT) || 5317, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022' },
});
