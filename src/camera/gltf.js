import * as THREE from 'three';

/**
 * Camera exchange through glTF 2.0 (.glb and .gltf). Pure functions: no DOM, no files, importable in Node.
 *
 * glTF is Y-up, -Z forward and metres, the same axes as three.js; Blender converts its own axes when it reads and writes glTF.
 * World units of this app convert to metres with `metres = unit * metresPerUnit + originMetres` (see `toMetres` / `fromMetres`).
 *
 * The file written by `encodeCameraGltf` has one camera node. With more than one frame it also has an animation on that node:
 * translation and rotation channels, one key per frame, LINEAR. glTF cannot animate `yfov`, so the field of view per frame is stored in
 * `extras.pyBoomBoomCamera.fovDegrees`. The same object is written on the node and on the camera.
 *
 * extras.pyBoomBoomCamera = {
 *   version: 1, source: 'PY-BoomBoom',
 *   fps, frameCount,                 // frame rate and number of frames of the shot (frame 0 is time 0)
 *   width, height, aspect,           // output resolution of the shot
 *   sensorHeightMm,                  // focal = sensorHeightMm / 2 / tan(yfov / 2); the sensor fit is always vertical
 *   focalMm,                         // focal length at frame 0
 *   metresPerUnit, unitsPerMetre,    // scene scale: 1 unit = metresPerUnit metres
 *   originMetres: [x, y, z],         // glTF position of this app's origin
 *   fovDegrees: number[]             // vertical field of view per frame (only when the animation has frames)
 *   targetDistances: number[]        // distance from the camera to its target per frame (this app's animation styles read it)
 * }
 * The node also carries the flat keys `focal_mm`, `sensor_height_mm` and `source` that the earlier PY-BoomBoom versions wrote.
 */

export const EXTRAS_KEY = 'pyBoomBoomCamera';
export const SENSOR_HEIGHT_MM = 20.25;
export const SEPARATE_BIN_MESSAGE = 'This .gltf uses a separate .bin file. In Blender, export as "glTF Binary (.glb)" or "glTF Embedded" instead.';

const D2R = Math.PI / 180;
const FLOAT = 5126;
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Focal length (mm) for a vertical field of view (degrees) and a sensor height (mm). */
export const fovToFocal = (fov, sensorHeight = SENSOR_HEIGHT_MM) => sensorHeight / 2 / Math.tan((fov * D2R) / 2);
/** Vertical field of view (degrees) for a focal length (mm) and a sensor height (mm). */
export const focalToFov = (mm, sensorHeight = SENSOR_HEIGHT_MM) => (2 * Math.atan(sensorHeight / 2 / mm)) / D2R;

/** World units to metres. */
export const toMetres = (p, scale = 1, origin = [0, 0, 0]) => p.map((v, i) => v * scale + origin[i]);
/** Metres to world units. */
export const fromMetres = (p, scale = 1, origin = [0, 0, 0]) => p.map((v, i) => (v - origin[i]) / scale);

// ------------------------------------------------------------------ build

/**
 * @typedef {Object} CameraFrame
 * @property {number[]} position world units
 * @property {number[]} quaternion [x,y,z,w]
 * @property {number} fov vertical degrees
 * @property {number} [distance] camera to target distance in world units
 */

/**
 * @typedef {Object} BuildOptions
 * @property {string} [name]
 * @property {number} fps
 * @property {CameraFrame[]} frames one frame is a still, more are an animation
 * @property {number} [frameCount] frames of the whole shot (default `frames.length`)
 * @property {number} width
 * @property {number} height
 * @property {number} [sensorHeight]
 * @property {number} [metresPerUnit]
 * @property {number[]} [originMetres]
 * @property {'glb'|'gltf'} [format]
 */

const pad4 = (n) => (n + 3) & ~3;

function floats(values) {
  const a = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) a[i] = values[i];
  return new Uint8Array(a.buffer);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Build the glTF document and its binary buffer.
 * @param {BuildOptions} o
 * @returns {{json:Object, bin:Uint8Array}}
 */
export function buildCameraGltf(o) {
  const { frames, fps } = o;
  if (!frames?.length) throw new Error('There is no camera frame to write.');
  const scale = o.metresPerUnit ?? 1, origin = o.originMetres ?? [0, 0, 0], sensor = o.sensorHeight ?? SENSOR_HEIGHT_MM;
  const animated = frames.length > 1;
  const first = frames[0];
  const extrasInfo = {
    version: 1, source: 'PY-BoomBoom', fps, frameCount: o.frameCount ?? frames.length, width: o.width, height: o.height, aspect: o.width / o.height,
    sensorHeightMm: sensor, focalMm: fovToFocal(first.fov, sensor), metresPerUnit: scale, unitsPerMetre: 1 / scale, originMetres: origin.slice(),
  };
  if (animated) extrasInfo.fovDegrees = frames.map((f) => f.fov);
  if (frames.every((f) => f.distance > 0)) extrasInfo[animated ? 'targetDistances' : 'targetDistance'] = animated ? frames.map((f) => f.distance) : first.distance;
  const extras = { [EXTRAS_KEY]: extrasInfo, focal_mm: extrasInfo.focalMm, sensor_height_mm: sensor, source: 'PY-BoomBoom' };
  const name = o.name || 'PY-BoomBoom camera';
  const pos0 = toMetres(first.position, scale, origin);
  const json = {
    asset: { version: '2.0', generator: 'PY-BoomBoom' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, camera: 0, translation: pos0, rotation: first.quaternion.slice(), extras }],
    cameras: [{
      name, type: 'perspective', extras,
      perspective: { yfov: first.fov * D2R, aspectRatio: o.width / o.height, znear: Math.max(1e-4, 0.1 * scale), zfar: 20000 * scale },
    }],
  };
  const parts = [];
  const view = (bytes, target) => {
    const offset = parts.reduce((n, p) => n + pad4(p.length), 0);
    parts.push(bytes);
    json.bufferViews ||= [];
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
    return json.bufferViews.length - 1;
  };
  if (animated) {
    const times = frames.map((_, i) => i / fps);
    const trans = frames.flatMap((f) => toMetres(f.position, scale, origin));
    const rots = [];
    let prev = null;
    for (const f of frames) {
      let q = f.quaternion;
      if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
      rots.push(...q);
      prev = q;
    }
    json.accessors = [
      { bufferView: view(floats(times)), componentType: FLOAT, count: frames.length, type: 'SCALAR', min: [Math.fround(times[0])], max: [Math.fround(times[times.length - 1])] },
      { bufferView: view(floats(trans)), componentType: FLOAT, count: frames.length, type: 'VEC3' },
      { bufferView: view(floats(rots)), componentType: FLOAT, count: frames.length, type: 'VEC4' },
    ];
    json.animations = [{
      name: 'Camera',
      samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }, { input: 0, output: 2, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }, { sampler: 1, target: { node: 0, path: 'rotation' } }],
    }];
  }
  const total = parts.reduce((n, p) => n + pad4(p.length), 0);
  const bin = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { bin.set(p, at); at += pad4(p.length); }
  if (total) json.buffers = [{ byteLength: total }];
  return { json, bin };
}

/** Pack a glTF document and its buffer into a binary .glb file. */
export function packGlb(json, bin) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = pad4(text.length), binLen = bin.length ? pad4(bin.length) : 0;
  const total = 12 + 8 + jsonLen + (binLen ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  if (binLen) {
    const at = 20 + jsonLen;
    dv.setUint32(at, binLen, true); dv.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}

/**
 * Write the camera to a file.
 * @param {BuildOptions} o
 * @returns {{data:Uint8Array|string, mime:string, extension:'glb'|'gltf'}} `.glb` is bytes, `.gltf` is text with an embedded base64 buffer
 */
export function encodeCameraGltf(o) {
  const { json, bin } = buildCameraGltf(o);
  if (o.format === 'gltf') {
    if (bin.length) json.buffers[0].uri = `data:application/octet-stream;base64,${toBase64(bin)}`;
    return { data: JSON.stringify(json, null, 1), mime: 'model/gltf+json', extension: 'gltf' };
  }
  return { data: packGlb(json, bin), mime: 'model/gltf-binary', extension: 'glb' };
}

// ------------------------------------------------------------------ parse

/**
 * Read a .glb (bytes) or .gltf (text or bytes) file into `{json, buffers}`. Data-URI and GLB buffers load; an external buffer file does not.
 * @param {ArrayBuffer|Uint8Array|string} input
 * @returns {{json:Object, buffers:Uint8Array[]}}
 */
export function parseGltf(input) {
  let bytes = null;
  let text;
  if (typeof input === 'string') text = input;
  else {
    bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === GLB_MAGIC) text = null;
    else text = new TextDecoder().decode(bytes);
  }
  const bad = () => new Error('The file is not valid glTF.');
  let json;
  let glbBin = null;
  if (text === null) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 20 || dv.getUint32(4, true) !== 2) throw new Error('The file is a glTF binary of an unsupported version. Use glTF 2.0.');
    const length = Math.min(dv.getUint32(8, true), bytes.length);
    let at = 12;
    while (at + 8 <= length) {
      const len = dv.getUint32(at, true), type = dv.getUint32(at + 4, true);
      if (at + 8 + len > bytes.length) throw bad();
      const body = bytes.subarray(at + 8, at + 8 + len);
      if (type === CHUNK_JSON && !json) { try { json = JSON.parse(new TextDecoder().decode(body)); } catch { throw bad(); } } else if (type === CHUNK_BIN && !glbBin) glbBin = body;
      at += 8 + pad4(len);
    }
    if (!json) throw bad();
  } else {
    try { json = JSON.parse(text); } catch { throw bad(); }
  }
  if (!json || typeof json !== 'object' || !String(json.asset?.version ?? '').startsWith('2')) throw new Error('The file is not a glTF 2.0 file.');
  const buffers = (json.buffers || []).map((b, i) => {
    if (typeof b.uri === 'string') {
      const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(b.uri);
      if (!m) throw new Error(SEPARATE_BIN_MESSAGE);
      return m[1] ? fromBase64(m[2]) : new TextEncoder().encode(decodeURIComponent(m[2]));
    }
    if (i === 0 && glbBin) return glbBin;
    throw new Error('The file has a buffer with no data.');
  });
  return { json, buffers };
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const READERS = { 5120: ['getInt8', 1, 127], 5121: ['getUint8', 1, 255], 5122: ['getInt16', 2, 32767], 5123: ['getUint16', 2, 65535], 5125: ['getUint32', 4, 0], 5126: ['getFloat32', 4, 0] };

/** Read an accessor as a flat array of numbers (normalised integers become floats in -1..1 or 0..1). */
function readAccessor(doc, index) {
  const acc = doc.json.accessors?.[index];
  if (!acc) throw new Error('The file refers to data that is not there.');
  const n = COMPONENTS[acc.type], reader = READERS[acc.componentType];
  if (!n || !reader) throw new Error('The file uses a number format this app cannot read.');
  if (acc.sparse) throw new Error('The file uses sparse animation data, which this app cannot read. In Blender, export with a normal (not sparse) animation.');
  const out = new Array(acc.count * n).fill(0);
  if (acc.bufferView === undefined) return out;
  const bv = doc.json.bufferViews?.[acc.bufferView];
  const buf = doc.buffers[bv?.buffer];
  if (!bv || !buf) throw new Error('The file refers to data that is not there.');
  const [fn, size, max] = reader;
  const stride = bv.byteStride || size * n;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  if (base + (acc.count - 1) * stride + size * n > buf.byteLength) throw new Error('The file is cut short: the animation data is missing.');
  const le = true;
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < n; c++) {
      const v = dv[fn](base + i * stride + c * size, le);
      out[i * n + c] = acc.normalized && max ? Math.max(v / max, -1) : v;
    }
  }
  return out;
}

/**
 * Cameras in the file, in node order.
 * @param {{json:Object}} doc
 * @returns {{node:number, name:string, type:string, yfov:number|null}[]}
 */
export function listCameras(doc) {
  const out = [];
  (doc.json.nodes || []).forEach((n, node) => {
    if (n.camera === undefined) return;
    const cam = doc.json.cameras?.[n.camera];
    if (!cam) return;
    out.push({ node, name: n.name || cam.name || `Camera ${out.length + 1}`, type: cam.type, yfov: cam.perspective ? cam.perspective.yfov / D2R : null });
  });
  return out;
}

const parentMap = (nodes) => {
  const parent = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  return parent;
};

/** A sampler as a function of time: returns an array of 3 (translation, scale) or 4 (rotation) numbers. */
function makeSampler(doc, sampler, path) {
  const times = readAccessor(doc, sampler.input);
  const values = readAccessor(doc, sampler.output);
  const n = path === 'rotation' ? 4 : 3;
  const mode = sampler.interpolation || 'LINEAR';
  const cubic = mode === 'CUBICSPLINE';
  const stride = cubic ? 3 * n : n;
  if (!times.length || values.length < times.length * stride) throw new Error('The animation data does not match its times.');
  const at = (k) => values.slice(k * stride + (cubic ? n : 0), k * stride + (cubic ? 2 * n : n));
  const unit = (v) => { if (path !== 'rotation') return v; const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const f = (t) => {
    const last = times.length - 1;
    if (t <= times[0]) return unit(at(0));
    if (t >= times[last]) return unit(at(last));
    let k = 0;
    while (times[k + 1] <= t) k++;
    const t0 = times[k], t1 = times[k + 1], u = (t - t0) / (t1 - t0);
    if (mode === 'STEP') return unit(at(k));
    const a = at(k), b = at(k + 1);
    if (cubic) {
      const out0 = values.slice(k * stride + 2 * n, k * stride + 3 * n), in1 = values.slice((k + 1) * stride, (k + 1) * stride + n), td = t1 - t0;
      const u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      return unit(a.map((v, i) => h00 * v + h10 * td * out0[i] + h01 * b[i] + h11 * td * in1[i]));
    }
    if (path === 'rotation') {
      const qa = new THREE.Quaternion(...a), qb = new THREE.Quaternion(...b);
      if (qa.dot(qb) < 0) { qb.x = -qb.x; qb.y = -qb.y; qb.z = -qb.z; qb.w = -qb.w; }
      return qa.slerp(qb, u).toArray();
    }
    return a.map((v, i) => v + (b[i] - v) * u);
  };
  return { f, t0: times[0], t1: times[times.length - 1] };
}

/** Our extras object from a node or its camera, or null. */
function readExtras(doc, node) {
  const cam = doc.json.cameras?.[doc.json.nodes[node].camera];
  const x = doc.json.nodes[node].extras?.[EXTRAS_KEY] ?? cam?.extras?.[EXTRAS_KEY];
  if (!x || typeof x !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const origin = Array.isArray(x.originMetres) && x.originMetres.length === 3 && x.originMetres.every((v) => num(v) !== null) ? x.originMetres.slice() : null;
  const dists = Array.isArray(x.targetDistances) && x.targetDistances.length && x.targetDistances.every((v) => num(v) !== null && v > 0) ? x.targetDistances.slice() : null;
  const fov = Array.isArray(x.fovDegrees) && x.fovDegrees.length && x.fovDegrees.every((v) => num(v) !== null && v > 0 && v < 180) ? x.fovDegrees.slice() : null;
  return {
    source: typeof x.source === 'string' ? x.source : '', fps: num(x.fps) > 0 ? x.fps : null, frameCount: Number.isInteger(x.frameCount) && x.frameCount > 0 ? x.frameCount : null,
    width: num(x.width) > 0 ? x.width : null, height: num(x.height) > 0 ? x.height : null,
    sensorHeightMm: num(x.sensorHeightMm) > 0 ? x.sensorHeightMm : null, metresPerUnit: num(x.metresPerUnit) > 0 ? x.metresPerUnit : null, originMetres: origin, fovDegrees: fov, targetDistances: dists,
  };
}

/**
 * @typedef {Object} ReadOptions
 * @property {number} fps frame rate the result is sampled at
 * @property {number} [metresPerUnit]
 * @property {number[]} [originMetres]
 * @property {boolean} [useFileScale] take the scale and origin from the file when it was written by this app
 */

/**
 * Read one camera: its world transform with all parent transforms and node scale applied, and every animation on the node or its parents,
 * sampled once per frame at `fps` (LINEAR, STEP and CUBICSPLINE). Positions are returned in world units of this app.
 * @param {{json:Object, buffers:Uint8Array[]}} doc
 * @param {number} node
 * @param {ReadOptions} o
 * @returns {{name:string, animated:boolean, frames:CameraFrame[], fps:number, sourceFps:number|null, frameCount:number,
 *   extras:ReturnType<typeof readExtras>, metresPerUnit:number, originMetres:number[], sourceDuration:number}}
 */
export function readCamera(doc, node, o) {
  const nodes = doc.json.nodes || [];
  const n = nodes[node];
  const cam = doc.json.cameras?.[n?.camera];
  if (!cam) throw new Error('This node is not a camera.');
  if (cam.type !== 'perspective' || !cam.perspective) throw new Error('This camera is orthographic. Only perspective cameras can be imported.');
  const extras = readExtras(doc, node);
  const scale = o.useFileScale && extras?.metresPerUnit ? extras.metresPerUnit : o.metresPerUnit ?? 1;
  const origin = o.useFileScale && extras?.originMetres ? extras.originMetres : o.originMetres ?? [0, 0, 0];
  const parent = parentMap(nodes);
  const chain = [];
  for (let i = node, guard = 0; i !== undefined && guard < 1000; i = parent.get(i), guard++) chain.unshift(i);
  const samplers = new Map();
  let t0 = Infinity, t1 = -Infinity;
  for (const anim of doc.json.animations || []) {
    for (const ch of anim.channels || []) {
      const path = ch.target?.path, target = ch.target?.node;
      if (!['translation', 'rotation', 'scale'].includes(path) || !chain.includes(target)) continue;
      const s = makeSampler(doc, anim.samplers[ch.sampler], path);
      samplers.set(`${target}:${path}`, s);
      t0 = Math.min(t0, s.t0); t1 = Math.max(t1, s.t1);
    }
  }
  const animated = samplers.size > 0;
  const fps = o.fps;
  const count = animated ? Math.floor((t1 - t0) * fps + 1e-6) + 1 : 1;
  const yfov = cam.perspective.yfov / D2R;
  const sourceFps = extras?.fps ?? null;
  const m = new THREE.Matrix4(), local = new THREE.Matrix4();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const frames = [];
  for (let f = 0; f < count; f++) {
    const t = t0 + f / fps;
    m.identity();
    for (const id of chain) {
      const nd = nodes[id];
      if (nd.matrix) local.fromArray(nd.matrix);
      else {
        const tr = samplers.get(`${id}:translation`)?.f(t) ?? nd.translation ?? [0, 0, 0];
        const ro = samplers.get(`${id}:rotation`)?.f(t) ?? nd.rotation ?? [0, 0, 0, 1];
        const sk = samplers.get(`${id}:scale`)?.f(t) ?? nd.scale ?? [1, 1, 1];
        local.compose(p.fromArray(tr), q.fromArray(ro).normalize(), sc.fromArray(sk));
      }
      m.multiply(local);
    }
    m.decompose(p, q, sc);
    let fov = yfov;
    if (extras?.fovDegrees) {
      const x = Math.min(Math.max(((t - t0) * (sourceFps ?? fps)), 0), extras.fovDegrees.length - 1), i = Math.floor(x), j = Math.min(i + 1, extras.fovDegrees.length - 1);
      fov = extras.fovDegrees[i] + (extras.fovDegrees[j] - extras.fovDegrees[i]) * (x - i);
    }
    let distance;
    if (extras?.targetDistances) {
      const x = Math.min(Math.max((t - t0) * (sourceFps ?? fps), 0), extras.targetDistances.length - 1), i = Math.floor(x), j = Math.min(i + 1, extras.targetDistances.length - 1);
      distance = extras.targetDistances[i] + (extras.targetDistances[j] - extras.targetDistances[i]) * (x - i);
    }
    frames.push({ position: fromMetres(p.toArray(), scale, origin), quaternion: q.toArray(), fov, distance });
  }
  return { name: n.name || cam.name || 'camera', animated, frames, fps, sourceFps, frameCount: count, extras, metresPerUnit: scale, originMetres: origin.slice(), sourceDuration: animated ? t1 - t0 : 0 };
}
