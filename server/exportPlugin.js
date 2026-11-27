// Vite dev-server middleware: receives raw 16-bit RGBA frames and drives ffmpeg.
// Output is written to exports/<name>.partial/ and renamed to exports/<name>/ only after ffmpeg finished cleanly.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { handlePresets } from './presets.js';

const ROOT = process.env.FW_EXPORTS_DIR ? path.resolve(process.env.FW_EXPORTS_DIR) : path.resolve(import.meta.dirname, '..', 'exports');
const IDLE_MS = 60000;

function findFfmpeg() {
  for (const p of [process.env.FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']) {
    if (!p) continue;
    const r = spawnSync(p, ['-version'], { encoding: 'utf8' });
    if (r.status === 0) return { path: p, version: r.stdout.split('\n')[0] };
  }
  return null;
}
const NO_FFMPEG = 'ffmpeg not found. Install it (e.g. `brew install ffmpeg`) or set FFMPEG_PATH.';

const json = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok) => { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => ok(Buffer.concat(b))); req.on('close', () => ok(Buffer.concat(b))); });
const safe = (s) => String(s || 'fireworks').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'fireworks';
const taken = (n) => fs.existsSync(path.join(ROOT, n)) || fs.existsSync(path.join(ROOT, n + '.partial'));

// take01 -> take02, name -> name_02; never reuses an existing folder
function uniqueName(base) {
  if (!taken(base)) return base;
  const m = base.match(/^(.*?)(\d+)$/);
  for (let i = m ? parseInt(m[2], 10) + 1 : 2; i < 10000; i++) {
    const n = m ? m[1] + String(i).padStart(m[2].length, '0') : `${base}_${String(i).padStart(2, '0')}`;
    if (!taken(n)) return n;
  }
  throw new Error('could not find a free export name');
}

function inputArgs(w, h, fps) {
  return ['-hide_banner', '-loglevel', 'warning', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba64le', '-s', `${w}x${h}`, '-framerate', String(fps), '-i', '-'];
}

function outputArgs(dir, name, fmt, alpha) {
  const out = [], hasAlpha = alpha !== 'black';
  if (fmt === 'prores' || fmt === 'both') {
    out.push('-map', '0:v', '-c:v', 'prores_ks', '-profile:v', '4444', '-vendor', 'apl0', '-alpha_bits', '16',
      '-vf', 'setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709,scale=out_color_matrix=bt709:out_range=tv',
      '-pix_fmt', hasAlpha ? 'yuva444p10le' : 'yuv444p10le',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', path.join(dir, `${name}.mov`));
  }
  if (fmt === 'png' || fmt === 'both') {
    fs.mkdirSync(path.join(dir, 'png'), { recursive: true });
    out.push('-map', '0:v', '-c:v', 'png', '-pix_fmt', hasAlpha ? 'rgba64be' : 'rgb48be', '-start_number', '1', path.join(dir, 'png', `${name}_%05d.png`));
  }
  return out;
}

export default function exportPlugin() {
  let job = null;

  const cleanup = (j) => {
    clearTimeout(j.idle);
    try { j.proc.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(j.partial, { recursive: true, force: true });
    if (job === j) job = null;
  };
  const arm = (j) => { clearTimeout(j.idle); j.idle = setTimeout(() => cleanup(j), IDLE_MS); };

  return {
    name: 'fireworks-export',
    configureServer(server) {
      // Vite binds 127.0.0.1 only (not reachable from the network). Also listen on the IPv6 loopback, so that
      // http://localhost:PORT works in browsers that resolve localhost to ::1 first, then print the URL to open.
      const httpServer = server.httpServer;
      if (httpServer) httpServer.once('listening', () => {
        const port = httpServer.address().port;
        const v6 = net.createServer((sock) => httpServer.emit('connection', sock));
        v6.on('error', () => {});   // IPv6 loopback unavailable: IPv4 alone is fine
        v6.listen(port, '::1');
        httpServer.once('close', () => v6.close());
        console.log(`\n  Open in your browser: http://localhost:${port}/   (also http://127.0.0.1:${port}/)\n`);
      });
      // same protections as the export API: custom header + same-origin check
      server.middlewares.use('/__presets', async (req, res) => {
        try {
          const origin = req.headers.origin;
          let sameOrigin = true;
          if (origin !== undefined) { try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; } }
          if (req.headers['x-fw-export'] !== '1' || !sameOrigin) { req.resume(); return json(res, 403, { error: 'forbidden' }); }
          const [code, body] = await handlePresets(req, new URL(req.url, 'http://x').pathname);
          json(res, code, body);
        } catch (e) { json(res, 500, { error: String(e.message || e) }); }
      });
      server.middlewares.use('/__export', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://x');
          const route = url.pathname;
          // Only our own page may talk to this API: custom header (forces a CORS preflight) + same-origin check.
          const origin = req.headers.origin;
          let sameOrigin = true;
          if (origin !== undefined) { try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; } }
          if (req.headers['x-fw-export'] !== '1' || !sameOrigin) { req.resume(); return json(res, 403, { error: 'forbidden' }); }
          if (route === '/ffmpeg') {
            const f = findFfmpeg();
            return json(res, f ? 200 : 404, f ? { ok: true, ...f } : { ok: false, error: NO_FFMPEG });
          }
          if (route === '/start') {
            const o = JSON.parse((await readBody(req)).toString());
            const f = findFfmpeg();
            if (!f) return json(res, 500, { error: NO_FFMPEG });
            if (!(o.width > 0 && o.height > 0 && o.fps > 0)) return json(res, 400, { error: 'bad dimensions' });
            if (job) cleanup(job);
            fs.mkdirSync(ROOT, { recursive: true });
            const name = uniqueName(safe(o.name)), partial = path.join(ROOT, name + '.partial'), final = path.join(ROOT, name);
            fs.mkdirSync(partial, { recursive: true });
            const args = [...inputArgs(o.width, o.height, o.fps), ...outputArgs(partial, name, o.format, o.alpha)];
            const proc = spawn(f.path, args, { stdio: ['pipe', 'ignore', 'pipe'] });
            const j = { id: crypto.randomBytes(8).toString('hex'), proc, partial, final, name, frames: 0, log: '', dead: false, bytes: o.width * o.height * 8 };
            job = j;
            proc.on('error', (e) => { j.log += String(e.message); j.dead = true; j.onDead?.(); });
            proc.stderr.on('data', (d) => { j.log += d.toString(); });
            proc.on('exit', () => { j.dead = true; j.onDead?.(); });
            proc.stdin.on('error', () => { j.dead = true; j.onDead?.(); });
            arm(j);
            return json(res, 200, { ok: true, id: j.id, name, dir: final, args: args.join(' ') });
          }
          if (route === '/frame' || route === '/finish' || route === '/cancel') {
            const j = job;
            if (!j || req.headers['x-fw-job'] !== j.id) { req.resume(); return json(res, route === '/cancel' ? 200 : 400, { ok: route === '/cancel', error: 'no matching export job' }); }
            if (route === '/cancel') { req.resume(); cleanup(j); return json(res, 200, { ok: true }); }
            if (route === '/frame') {
              if (Number(req.headers['content-length']) !== j.bytes) { req.resume(); return json(res, 400, { error: `bad frame size ${req.headers['content-length']}, expected ${j.bytes}` }); }
              if (j.dead) { req.resume(); const log = j.log.slice(-600); cleanup(j); return json(res, 500, { error: 'ffmpeg exited early: ' + log }); }
              arm(j);
              let got = 0, aborted = false;
              await new Promise((ok) => {
                const stop = () => { aborted = true; ok(); };
                j.onDead = () => { req.resume(); ok(); };          // never hang on a dead ffmpeg
                req.on('close', () => { if (!req.complete) stop(); });
                req.on('data', (c) => {
                  got += c.length;
                  if (j.dead) return;
                  if (!j.proc.stdin.write(c)) { req.pause(); j.proc.stdin.once('drain', () => req.resume()); }
                });
                req.on('end', ok);
              });
              j.onDead = null;
              if (j.dead || aborted || got !== j.bytes) { const log = j.log.slice(-600); cleanup(j); return json(res, 500, { error: j.dead ? 'ffmpeg exited early: ' + log : 'frame upload aborted' }); }
              j.frames++;
              return json(res, 200, { ok: true, frames: j.frames });
            }
            // finish: close stdin so ffmpeg writes the moov atom, then rename .partial -> final
            clearTimeout(j.idle);
            const code = await new Promise((ok) => { if (j.dead) return ok(j.proc.exitCode); j.proc.on('exit', ok); j.proc.stdin.end(); });
            if (code !== 0) { const log = j.log.slice(-800); cleanup(j); return json(res, 500, { error: 'ffmpeg failed: ' + log }); }
            fs.renameSync(j.partial, j.final);
            job = null;
            return json(res, 200, { ok: true, name: j.name, dir: j.final, frames: j.frames, files: fs.readdirSync(j.final), log: j.log });
          }
          if (route === '/still') {
            const w = +url.searchParams.get('w'), h = +url.searchParams.get('h'), alpha = url.searchParams.get('alpha');
            if (!(w > 0 && h > 0) || Number(req.headers['content-length']) !== w * h * 8) { req.resume(); return json(res, 400, { error: 'bad still size' }); }
            const dir = path.join(ROOT, 'stills');
            fs.mkdirSync(dir, { recursive: true });
            const f = findFfmpeg();
            if (!f) { req.resume(); return json(res, 500, { error: NO_FFMPEG }); }
            const body = await readBody(req);
            const file = path.join(dir, `${safe(url.searchParams.get('name'))}_still_${Date.now()}.png`);
            const r = spawnSync(f.path, [...inputArgs(w, h, 1), '-frames:v', '1', '-pix_fmt', alpha !== 'black' ? 'rgba64be' : 'rgb48be', file], { input: body });
            if (r.status !== 0) return json(res, 500, { error: 'ffmpeg failed: ' + r.stderr.toString().slice(-600) });
            return json(res, 200, { ok: true, file });
          }
          json(res, 404, { error: 'unknown route' });
        } catch (e) {
          json(res, 500, { error: String(e.message || e) });
        }
      });
    },
  };
}
