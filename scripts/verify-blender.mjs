// Real Blender check (headless) of the glTF camera exchange. Needs Blender; set BLENDER_PATH if it is not in /Applications.
// Run `npm run verify:ui` first (it writes verification/app-camera.gltf). Run: npm run verify:blender
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..'), OUT = path.join(ROOT, 'verification');
const BLENDER = process.env.BLENDER_PATH || '/Applications/Blender.app/Contents/MacOS/Blender';
if (!fs.existsSync(BLENDER)) { console.log('SKIP blender not found (set BLENDER_PATH). The Blender camera exchange is NOT verified against Blender.'); process.exit(2); }
let failed = 0;
const check = (n, pass, d = {}) => { if (!pass) failed++; console.log(pass ? 'PASS' : 'FAIL', n, JSON.stringify(d).slice(0, 400)); };
const runBlender = (script, ...args) => spawnSync(BLENDER, ['--background', '--python', path.join(ROOT, 'scripts/blender', script), '--', ...args], { encoding: 'utf8' });

// quaternion helpers, [w,x,y,z]
const mul = (a, b) => [a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3], a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2], a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1], a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];
const conj = (a) => [a[0], -a[1], -a[2], -a[3]];
const C = [Math.SQRT1_2, Math.SQRT1_2, 0, 0];   // world axis change Y-up -> Z-up: rotate +90 deg about X
const dotAbs = (a, b) => Math.abs(a.reduce((s, v, i) => s + v * b[i], 0));
const eulerXYZ = (x, y, z) => { const q = (a, ax) => { const s = Math.sin(a / 2), c = Math.cos(a / 2); return ax === 0 ? [c, s, 0, 0] : ax === 1 ? [c, 0, s, 0] : [c, 0, 0, s]; }; return mul(q(z, 2), mul(q(y, 1), q(x, 0))); };

// A) app -> Blender
{
  const exp = JSON.parse(fs.readFileSync(path.join(OUT, 'app-camera-expected.json'), 'utf8'));
  runBlender('read_camera.py', path.join(OUT, 'app-camera.gltf'), path.join(OUT, 'blender-read.json'));
  const b = JSON.parse(fs.readFileSync(path.join(OUT, 'blender-read.json'), 'utf8'));
  const [px, py, pz] = exp.p, wantLoc = [px, -pz, py], qt = [exp.q[3], exp.q[0], exp.q[1], exp.q[2]], wantQ = mul(C, qt);
  const dl = Math.max(...wantLoc.map((v, i) => Math.abs(v - b.location[i])));
  check('app_to_blender_position', dl < 1e-3, { want: wantLoc, got: b.location });
  check('app_to_blender_rotation', dotAbs(wantQ, b.quat_wxyz) > 0.99999, { dot: dotAbs(wantQ, b.quat_wxyz) });
  const fovWant = 2 * Math.atan(20.25 / 2 / exp.f);
  check('app_to_blender_field_of_view', Math.abs(b.angle_y - fovWant) < 1e-4, { want: fovWant, got: b.angle_y, lens_mm_in_blender: b.lens });
}

// B) Blender -> app
{
  const gl = path.join(OUT, 'blender-camera.gltf');
  const r = runBlender('make_camera.py', gl);
  check('blender_wrote_gltf', fs.existsSync(gl), { tail: r.stdout.split('\n').slice(-3).join(' | ') });
  const PORT = 5351 + Math.floor(Math.random() * 40), URL_ = `http://127.0.0.1:${PORT}/`;
  const sv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js')], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, FW_PORT: String(PORT), FW_PRESETS_DIR: path.join(OUT, '_presets_bl') } });
  process.on('exit', () => sv.kill());
  for (let i = 0; i < 60; i++) { try { if ((await fetch(URL_)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 500)); }
  const br = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await br.newPage(); await page.goto(URL_); await page.waitForFunction(() => window.__fw?.blender, { timeout: 20000 });
  const got = await page.evaluate(async (text) => { const fw = window.__fw; fw.blender.importCamera(text); await new Promise((r) => setTimeout(r, 500)); const rg = fw.app.rig; rg.camera.updateMatrixWorld(); return { p: rg.camera.position.toArray(), q: rg.camera.quaternion.toArray(), f: rg.focal }; }, fs.readFileSync(gl, 'utf8'));
  const wantP = [30, 25, 400], wantQb = eulerXYZ((88 * Math.PI) / 180, 0, (5 * Math.PI) / 180), wantQt = mul(conj(C), wantQb);
  const gotQ = [got.q[3], got.q[0], got.q[1], got.q[2]];
  check('blender_to_app_position', Math.max(...wantP.map((v, i) => Math.abs(v - got.p[i]))) < 1e-2, { want: wantP, got: got.p });
  check('blender_to_app_rotation', dotAbs(wantQt, gotQ) > 0.99999, { dot: dotAbs(wantQt, gotQ) });
  check('blender_to_app_focal_length', Math.abs(got.f - 35) < 0.1, { got: got.f });
  // C) real file picker + Blender's default .glb with a mesh in the scene; D) .gltf + separate .bin gives a plain message
  const glb = path.join(OUT, 'blender-scene.glb'), sep = path.join(OUT, 'blender-scene-sep.gltf');
  runBlender('make_scene.py', glb, 'GLB'); runBlender('make_scene.py', sep, 'GLTF_SEPARATE');
  check('blender_wrote_glb_and_separate', fs.existsSync(glb) && fs.existsSync(sep) && fs.existsSync(sep.replace('.gltf', '.bin')), {});
  const openFolder = () => page.evaluate(() => { const t = [...document.querySelectorAll('.lil-title')].find((e) => e.textContent.trim() === 'Blender camera (glTF)'); if (t && t.parentElement.classList.contains('lil-closed')) t.click(); });
  const pick = async (file) => {
    await openFolder(); await new Promise((r) => setTimeout(r, 700));
    const h = await page.evaluateHandle(() => [...document.querySelectorAll('.lil-controller.lil-function')].find((e) => /Get camera from Blender/.test(e.textContent)));
    const [chooser] = await Promise.all([page.waitForFileChooser(), h.asElement().click()]);
    await chooser.accept([file]); await new Promise((r) => setTimeout(r, 1200));
    return page.evaluate(() => { const rg = window.__fw.app.rig; rg.camera.updateMatrixWorld(); return { p: rg.camera.position.toArray(), q: rg.camera.quaternion.toArray(), f: rg.focal, msg: document.getElementById('progress').textContent }; });
  };
  const reset = () => page.evaluate(() => { const a = window.__fw.app; a.state.camera.baked = null; a.state.camera.keys = []; a.state.camera.view = 'free'; window.__fw.setCamera({ view: 'Front' }); });
  await reset();
  const g = await pick(glb);
  check('picker_glb_with_mesh_position', Math.max(...wantP.map((v, i) => Math.abs(v - g.p[i]))) < 1e-2, { got: g.p, msg: g.msg });
  check('picker_glb_with_mesh_rotation', dotAbs(wantQt, [g.q[3], g.q[0], g.q[1], g.q[2]]) > 0.99999 && Math.abs(g.f - 35) < 0.1, { f: g.f });
  await reset();
  const sp = await pick(sep);
  check('picker_gltf_with_bin_gives_plain_message', /\.glb/.test(sp.msg) && Math.abs(sp.p[2] - 560) < 1e-3, { msg: sp.msg, z: sp.p[2] });

  // D) animated camera app -> Blender: every frame matches (Blender frame rate = export fps = 24)
  {
    const want = JSON.parse(fs.readFileSync(path.join(OUT, 'app-anim-expected.json'), 'utf8'));
    runBlender('read_anim.py', path.join(OUT, 'app-anim.glb'), path.join(OUT, 'blender-anim-read.json'), '24', ...want.map((w) => String(w.f)));
    const b = JSON.parse(fs.readFileSync(path.join(OUT, 'blender-anim-read.json'), 'utf8'));
    let dl = 0, dq = 1;
    for (const [i, w] of want.entries()) {
      const [px, py, pz] = w.position, wl = [px, -pz, py], wq = mul(C, [w.quaternion[3], w.quaternion[0], w.quaternion[1], w.quaternion[2]]);
      dl = Math.max(dl, ...wl.map((v, k) => Math.abs(v - b.poses[i].location[k]))); dq = Math.min(dq, dotAbs(wq, b.poses[i].quat_wxyz));
    }
    check('anim_app_to_blender_frames_match', b.frame_end - b.frame_start === 48 && dl < 1e-3 && dq > 0.99999, { frames: b.frame_end - b.frame_start + 1, maxPositionError: dl, minQuatDot: dq });
  }
  // E) animated camera Blender -> app: poses at the start, middle and end match what Blender evaluates
  {
    const glbA = path.join(OUT, 'blender-anim.glb'), infoA = path.join(OUT, 'blender-anim-poses.json');
    runBlender('make_anim.py', glbA, infoA);
    const bp = JSON.parse(fs.readFileSync(infoA, 'utf8')), bytes = Array.from(fs.readFileSync(glbA));
    await reset();
    const got = await page.evaluate(async (bytes) => {
      const fw = window.__fw, info = fw.blender.importCamera(new Uint8Array(bytes).buffer);
      return { info, poses: [0, 0.5, 1].map((t) => fw.camera.poseAt(t)) };
    }, bytes);
    let dl = 0, dq = 1;
    for (const [i, b] of bp.entries()) {
      const wl = [b.location[0], b.location[2], -b.location[1]], wq = mul(conj(C), b.quat_wxyz), g = got.poses[i];
      dl = Math.max(dl, ...wl.map((v, k) => Math.abs(v - g.position[k]))); dq = Math.min(dq, dotAbs(wq, [g.quaternion[3], g.quaternion[0], g.quaternion[1], g.quaternion[2]]));
    }
    check('anim_blender_to_app_poses_match', got.info.animated && got.info.frames === 25 && got.info.fps === 24 && dl < 1e-2 && dq > 0.9999, { info: got.info, maxPositionError: dl, minQuatDot: dq });
  }

  // F) the Blender helper scripts: the load script sets frame rate, size, frame range and keys the lens; the save script writes the lens animation back
  {
    const want = JSON.parse(fs.readFileSync(path.join(OUT, 'app-anim-expected.json'), 'utf8'));
    const repF = path.join(OUT, 'blender-load-script.json');
    const rl = spawnSync(BLENDER, ['--background', '--python', path.join(ROOT, 'public/blender-scripts/import_camera.py'), '--', path.join(OUT, 'app-anim.glb'), repF], { encoding: 'utf8' });
    const rep = fs.existsSync(repF) ? JSON.parse(fs.readFileSync(repF, 'utf8')) : null;
    const fovOf = (focal) => 2 * Math.atan(20.25 / 2 / focal);
    const rows = rep ? rep.rows : [];
    const worst = rows.length ? Math.max(...rows.map((r) => Math.abs(r.angle_y - fovOf(want.find((w) => w.f === r.frame - rep.frame_start)?.focal ?? NaN)))) : NaN;
    check('blender_script_load_sets_scene_and_keys_lens', !!rep && rep.fps === 24 && rep.resolution[0] === 1920 && rep.resolution[1] === 1080 && rep.sensor_fit === 'VERTICAL' && rep.frame_end - rep.frame_start === 48 && rep.active && worst < 1e-4,
      { fps: rep?.fps, resolution: rep?.resolution, frames: rep && rep.frame_end - rep.frame_start + 1, worstFovErrorRad: worst, tail: rep ? '' : rl.stdout.split('\n').slice(-4).join(' | ') });
    // Blender lens animation -> file -> app
    const blend = path.join(OUT, 'zoom.blend'), zglb = path.join(OUT, 'zoom.glb');
    runBlender('make_zoom_scene.py', blend);
    const rs = spawnSync(BLENDER, ['--background', blend, '--python', path.join(ROOT, 'public/blender-scripts/export_camera.py'), '--', zglb], { encoding: 'utf8' });
    check('blender_script_save_wrote_glb', fs.existsSync(zglb), { tail: rs.stdout.split('\n').slice(-3).join(' | ') });
    await reset();
    const z = await page.evaluate(async (bytes) => { const fw = window.__fw, info = fw.blender.importCamera(new Uint8Array(bytes).buffer); return { info, f: [0, 0.5, 1].map((t) => fw.camera.poseAt(t).focal) }; }, Array.from(fs.readFileSync(zglb)));
    check('blender_lens_animation_reaches_app', z.info.frames === 25 && Math.abs(z.f[0] - 35) < 0.05 && Math.abs(z.f[2] - 70) < 0.05 && z.f[1] > 40 && z.f[1] < 65, { info: z.info, focal: z.f });
  }
  await br.close(); sv.kill();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Blender checks passed');
process.exit(failed ? 1 : 0);
