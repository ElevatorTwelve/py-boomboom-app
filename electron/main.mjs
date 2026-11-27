// Desktop wrapper: runs the Vite app (with its preset and export middleware) and shows it in a window.
import { app, BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const data = app.getPath('userData');
const presets = path.join(data, 'presets');
if (!fs.existsSync(presets)) fs.cpSync(path.join(root, 'presets'), presets, { recursive: true });
process.env.FW_PRESETS_DIR ||= presets;
process.env.FW_EXPORTS_DIR ||= path.join(app.getPath('documents'), 'PY-BoomBoom Exports');

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    cacheDir: path.join(data, 'vite-cache'),
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const win = new BrowserWindow({ width: 1440, height: 900, title: 'PY-BoomBoom' });
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (!u.startsWith(url)) shell.openExternal(u);
    return { action: u.startsWith(url) ? 'allow' : 'deny' };
  });
  win.loadURL(url);
  app.on('window-all-closed', async () => { await server.close(); app.quit(); });
});
