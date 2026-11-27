// Camera animation: one pose function used by the preview, the still, the export and the glTF bake.
// Time is OUTPUT time in seconds: frame N of an export is at N / fps, and so is frame N in Blender (set the Blender frame rate to the export fps).
// The preview converts its simulation time with: output time = playhead / timeScale.
// Adapted from the camera path code of the Logo-Vanity project (position, target, focal length, roll, easing, bezier path).
import * as THREE from 'three';
import { ease, EASINGS } from './easing.js';
import { SENSOR_HEIGHT_MM } from './gltf.js';

const D2R = Math.PI / 180;
export const SENSOR_H = SENSOR_HEIGHT_MM;
export const EASE_NAMES = ['linear', 'in-quad', 'out-quad', 'in-out-quad', 'in-out-cubic', 'out-cubic', 'in-out-quart'].filter((n) => EASINGS[n]);
export const fovOfFocal = (mm) => (2 * Math.atan(SENSOR_H / 2 / mm)) / D2R;
export const focalOfFov = (fov) => SENSOR_H / 2 / Math.tan((fov * D2R) / 2);

export const newKey = (o = {}) => ({ t: 0, position: [0, 6, 520], target: [0, 160, 0], focal: 50, roll: 0, interp: 'bezier', ease: 'linear', ...o });

const same = (a, b) => a.every((v, i) => v === b[i]);
const equalKeys = (a, b) => same(a.position, b.position) && same(a.target, b.target) && a.focal === b.focal && a.roll === b.roll;
/** Frame number of an output time, and the time of a frame. Keys sit on whole frames. */
export const frameOf = (t, fps) => Math.round(t * fps);
export const timeOfFrame = (f, fps) => f / fps;

const lerpV = (a, b, u) => a.map((x, i) => x + (b[i] - x) * u);

function bezierControls(vals, times, i) {
  const n = vals.length, dt = times[i + 1] - times[i];
  // a key next to an identical key is a hold: flat tangent there, so the path does not bulge past it
  const tangent = (k) => { const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1), span = times[b] - times[a] || 1; if ((k > 0 && same(vals[k], vals[k - 1])) || (k < n - 1 && same(vals[k], vals[k + 1]))) return vals[k].map(() => 0); return vals[k].map((_, c) => (vals[b][c] - vals[a][c]) / span); };
  const m0 = tangent(i), m1 = tangent(i + 1);
  return [vals[i], vals[i].map((x, c) => x + (m0[c] * dt) / 3), vals[i + 1].map((x, c) => x - (m1[c] * dt) / 3), vals[i + 1]];
}
function evalBezier(c, u) {
  const v = 1 - u, w0 = v * v * v, w1 = 3 * v * v * u, w2 = 3 * v * u * u, w3 = u * u * u;
  return c[0].map((_, k) => w0 * c[0][k] + w1 * c[1][k] + w2 * c[2][k] + w3 * c[3][k]);
}

/** Keys (sorted by t) at output time t -> { position, target, focal, roll }. Holds the first / last key outside the range. */
export function evaluateKeys(keys, t) {
  const n = keys.length;
  const pose = (k) => ({ position: k.position.slice(), target: k.target.slice(), focal: k.focal, roll: k.roll });
  if (n === 1 || t <= keys[0].t) return pose(keys[0]);
  if (t >= keys[n - 1].t) return pose(keys[n - 1]);
  let i = 0; while (keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1], u = ease(a.ease || 'linear', (t - a.t) / (b.t - a.t)), times = keys.map((k) => k.t);
  if (equalKeys(a, b)) return pose(a);   // two identical keys hold the pose between them
  let position, target;
  if (a.interp === 'bezier' && n > 2) {
    position = evalBezier(bezierControls(keys.map((k) => k.position), times, i), u);
    target = evalBezier(bezierControls(keys.map((k) => k.target), times, i), u);
  } else { position = lerpV(a.position, b.position, u); target = lerpV(a.target, b.target, u); }
  return { position, target, focal: a.focal + (b.focal - a.focal) * u, roll: a.roll + (b.roll - a.roll) * u };
}

const _m = new THREE.Matrix4(), _f = new THREE.Vector3(), _up = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3();
/** Orientation (quaternion [x,y,z,w]) that looks from position to target with the given roll (degrees). */
export function quaternionFromAim(position, target, roll) {
  _p.fromArray(position); _t.fromArray(target); _f.subVectors(_t, _p);
  if (_f.lengthSq() < 1e-12) _f.set(0, 0, -1);
  _f.normalize();
  if (Math.abs(_f.y) > 0.9999) _up.set(0, 0, Math.sign(_f.y)); else _up.set(0, 1, 0);
  _up.applyAxisAngle(_f, roll * D2R);
  _m.lookAt(_p, _t, _up);
  return new THREE.Quaternion().setFromRotationMatrix(_m).toArray();
}

/** Target and roll that rebuild a given orientation (used to turn imported frames into keys). */
export function aimFromQuaternion(position, quaternion, distance) {
  const q = new THREE.Quaternion().fromArray(quaternion).normalize();
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q), u = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const ref = Math.abs(f.y) > 0.9999 ? new THREE.Vector3(0, 0, Math.sign(f.y)) : new THREE.Vector3(0, 1, 0);
  ref.addScaledVector(f, -ref.dot(f)).normalize();
  const roll = Math.atan2(u.dot(new THREE.Vector3().crossVectors(f, ref)), u.dot(ref)) / D2R;
  return { target: new THREE.Vector3().fromArray(position).addScaledVector(f, distance).toArray(), roll };
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
/** Imported animation: one pose per frame, linear position / fov and slerp between frames; held before the first and after the last frame. */
export function evaluateBaked(b, t) {
  const x = Math.min(Math.max(t * b.fps, 0), b.count - 1), i = Math.min(Math.floor(x), b.count - 1), j = Math.min(i + 1, b.count - 1), u = x - i;
  const position = [0, 1, 2].map((n) => b.position[i * 3 + n] + (b.position[j * 3 + n] - b.position[i * 3 + n]) * u);
  _qa.fromArray(b.quaternion, i * 4); _qb.fromArray(b.quaternion, j * 4);
  if (_qa.dot(_qb) < 0) { _qb.x = -_qb.x; _qb.y = -_qb.y; _qb.z = -_qb.z; _qb.w = -_qb.w; }
  _qa.slerp(_qb, u);
  const q = _qa.toArray(), aim = aimFromQuaternion(position, q, 100);
  return { position, target: aim.target, roll: aim.roll, quaternion: q, focal: focalOfFov(b.fov[i] + (b.fov[j] - b.fov[i]) * u) };
}

/** True when the state holds a camera animation (keys or an imported animation). */
export const hasCamera = (c) => !!(c && (c.baked || (c.keys && c.keys.length)));
/** Length in output seconds. */
export const cameraLength = (c) => (c.baked ? (c.baked.count - 1) / c.baked.fps : c.keys.length ? c.keys[c.keys.length - 1].t : 0);

/** The one pose function. Returns { position, quaternion, focal } or null when there is no camera animation. */
export function poseAt(c, t) {
  if (!hasCamera(c)) return null;
  if (c.baked) return evaluateBaked(c.baked, t);
  const k = evaluateKeys(c.keys, t);
  return { position: k.position, target: k.target, roll: k.roll, quaternion: quaternionFromAim(k.position, k.target, k.roll), focal: k.focal };
}

/** Independent copy that stays valid while the user edits (used by the export). Returns a function t -> pose, or null. */
export function snapshotCamera(c) {
  if (!hasCamera(c)) return null;
  const copy = c.baked ? { baked: c.baked, keys: [] } : { baked: null, keys: JSON.parse(JSON.stringify(c.keys)) };   // baked data is never edited, only replaced
  return (t) => poseAt(copy, t);
}

/** Frames for the glTF file: one per output frame from 0 to the end of the animation. */
export function bakeFrames(c, fps) {
  const n = Math.max(1, Math.round(cameraLength(c) * fps) + 1), frames = [];
  for (let i = 0; i < n; i++) {
    const p = poseAt(c, i / fps);
    frames.push({ position: p.position, quaternion: p.quaternion, fov: fovOfFocal(p.focal) });
  }
  return frames;
}

/** Approximate keys from an imported animation (about maxKeys keys; the imported animation itself stays exact until you convert). */
export function bakedToKeys(b, maxKeys = 30) {
  const step = Math.max(1, Math.ceil((b.count - 1) / (maxKeys - 1))), frames = [];
  for (let f = 0; f < b.count - 1; f += step) frames.push(f);
  frames.push(b.count - 1);
  return frames.map((f) => {
    const p = evaluateBaked(b, f / b.fps), aim = aimFromQuaternion(p.position, p.quaternion, 100);
    return newKey({ t: f / b.fps, position: p.position, target: aim.target, focal: p.focal, roll: aim.roll, interp: 'bezier', ease: 'linear' });
  });
}
