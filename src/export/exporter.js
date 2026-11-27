import { World } from '../sim/world.js';
import { fovOfFocal } from '../camera/path.js';

const HDR = { 'X-FW-Export': '1' };
export const AUTO_CAP_SECONDS = 600;   // auto-duration exports stop here at the latest (the result says so if the world was not finished)
let exportWorld = null;   // the exporter steps its own World, so Fire/Replay or seed changes in the UI cannot touch it
const post = async (url, body, headers) => {
  const r = await fetch(url, { method: 'POST', body, headers: { ...HDR, ...headers } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
export const getFfmpeg = () => fetch('/__export/ffmpeg', { headers: HDR }).then((r) => r.json());

export const FORMATS = { 'ProRes 4444 + PNG': 'both', 'ProRes 4444 (.mov)': 'prores', 'PNG sequence (16-bit)': 'png' };

// float RGBA (bottom-up, GL order) -> 16-bit RGBA top-down
export function toU16(src, dst, w, h, forceOpaque) {
  for (let y = 0; y < h; y++) {
    let s = (h - 1 - y) * w * 4, d = y * w * 4;
    for (let x = 0; x < w * 4; x++, s++, d++) {
      const v = src[s];
      dst[d] = v <= 0 ? 0 : v >= 1 ? 65535 : (v * 65535 + 0.5) | 0;
    }
    if (forceOpaque) for (let x = 3; x < w * 4; x += 4) dst[y * w * 4 + x] = 65535;
  }
}

// Offline, deterministic export: resets the sim with the current seed, steps frame by frame.
// Everything is snapshotted at start, so editing sliders mid-export cannot change frames.
export async function runExport(app, over, onProgress, signal) {
  const { renderer, state } = app;
  const world = exportWorld || (exportWorld = new World());
  const snap = structuredClone({ physics: state.physics, render: state.render, elements: state.elements, shot: app.shotForWorld(), export: { ...state.export, ...over } });
  const E = snap.export, seed = app.currentSeed();
  const w = Math.round(E.width), h = Math.round(E.height), fps = E.fps, N = Math.max(1, E.samples | 0);
  const fmt = FORMATS[E.format] || E.format;
  const ts = snap.physics.timeScale;
  const S = (snap.render.shutterAngle / 360) / fps * ts;
  const cam = app.rig.camera.clone(); cam.aspect = w / h; cam.updateProjectionMatrix(); cam.updateMatrixWorld();   // before any await
  const poseOf = app.cameraSnapshot();   // camera animation (also before any await); null = the live view, as before
  app.lastExportPoses = poseOf ? [] : null;   // what the camera did, frame by frame (read by the checks)
  const setPose = (p) => { cam.position.set(...p.position); cam.quaternion.set(...p.quaternion).normalize(); cam.fov = fovOfFocal(p.focal); cam.updateProjectionMatrix(); cam.updateMatrixWorld(); };
  const start = await post('/__export/start', JSON.stringify({ name: E.name, width: w, height: h, fps, format: fmt, alpha: E.alpha }), { 'content-type': 'application/json' });
  const jobH = { ...HDR, 'X-FW-Job': start.id };
  const f32 = new Float32Array(w * h * 4), u16 = new Uint16Array(w * h * 4);
  const maxFrames = E.duration > 0 ? Math.round(E.duration * fps) : Math.round(AUTO_CAP_SECONDS * fps);
  world.reset(seed, snap.shot, snap.physics); renderer.prep.dropped = 0;
  const t0 = performance.now();
  let f = 0;
  try {
    for (; f < maxFrames; f++) {
      if (signal?.aborted) throw new Error('cancelled');
      const T = f / fps * ts, samples = [];
      if (poseOf) { const p = poseOf(f / fps); setPose(p); app.lastExportPoses.push({ f, position: p.position, focal: p.focal }); }   // same pose function as the preview; no camera motion blur
      for (let i = 0; i < N; i++) samples.push([T + i * S / N, T + (i + 1) * S / N]);
      const fin = renderer.render(world, cam, { width: w, height: h, samples, el: snap.elements, rp: snap.render, target: 'float', alpha: E.alpha });
      renderer.readFloat(fin, f32);
      toU16(f32, u16, w, h, E.alpha === 'black');
      await post('/__export/frame', u16.buffer, { ...jobH, 'content-type': 'application/octet-stream' });
      onProgress?.({ frame: f + 1, total: E.duration > 0 ? maxFrames : null, elapsed: (performance.now() - t0) / 1000, simTime: world.t, name: start.name });
      if (E.duration <= 0 && world.finished && f > 2) { f++; break; }
    }
    const res = await post('/__export/finish', '{}', { ...jobH, 'content-type': 'application/json' });
    const hitCap = E.duration <= 0 && !world.finished;
    return { ...res, width: w, height: h, fps, seconds: f / fps, elapsed: (performance.now() - t0) / 1000, hitCap, overflow: world.overflow, overflowSmoke: world.overflowSmoke, dropped: renderer.prep.dropped };
  } catch (e) {
    await fetch('/__export/cancel', { method: 'POST', headers: jobH }).catch(() => {});
    throw e;
  } finally {
    exportWorld = null;   // release the export world's pools (can be large after a finale)
  }
}

export async function saveStill(app) {
  const { renderer, world, state } = app;
  const E = state.export, w = Math.round(E.width), h = Math.round(E.height);
  const cam = app.rig.camera.clone(); cam.aspect = w / h; cam.updateProjectionMatrix();
  const poseOf = app.cameraSnapshot();
  if (poseOf) { const p = poseOf(app.playhead / state.physics.timeScale); cam.position.set(...p.position); cam.quaternion.set(...p.quaternion).normalize(); cam.fov = fovOfFocal(p.focal); cam.updateProjectionMatrix(); cam.updateMatrixWorld(); }
  const S = (state.render.shutterAngle / 360) / E.fps * state.physics.timeScale, T = app.playhead;
  const fin = renderer.render(world, cam, { width: w, height: h, samples: [[T, T + S]], el: state.elements, rp: state.render, target: 'float', alpha: E.alpha });
  const f32 = renderer.readFloat(fin, new Float32Array(w * h * 4)), u16 = new Uint16Array(w * h * 4);
  toU16(f32, u16, w, h, E.alpha === 'black');
  return post(`/__export/still?w=${w}&h=${h}&alpha=${E.alpha}&name=${encodeURIComponent(E.name)}`, u16.buffer, { 'content-type': 'application/octet-stream' });
}
