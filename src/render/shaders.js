// All imagery is generated here: procedural sprites/noise in GLSL, no textures.

export const lightVS = /* glsl */`
uniform vec2 uRes; uniform float uPx; uniform float uMinSigma;
attribute vec3 iP0; attribute vec3 iP1; attribute vec3 iCol; attribute float iSize;
varying vec2 vLocal; varying float vL; varying float vSig; varying vec3 vCol; varying vec2 vC; varying float vSp; varying float vHalo;
void main() {
  vec4 a = projectionMatrix * viewMatrix * vec4(iP0, 1.0);
  vec4 b = projectionMatrix * viewMatrix * vec4(iP1, 1.0);
  if (a.w < 0.5 || b.w < 0.5) { gl_Position = vec4(3.0, 3.0, 3.0, 1.0); vLocal = vec2(0.0); vL = 0.0; vSig = 1.0; vCol = vec3(0.0); vC = vec2(0.0); vSp = 0.0; vHalo = 1.0; return; }
  vec2 sa = (a.xy / a.w * 0.5 + 0.5) * uRes;
  vec2 sb = (b.xy / b.w * 0.5 + 0.5) * uRes;
  float wm = 0.5 * (a.w + b.w);
  float sigPhys = iSize * projectionMatrix[1][1] * uRes.y * 0.5 / wm;
  float sigma = max(sigPhys, uMinSigma * uPx);
  float f = sigPhys / sigma;
  vCol = iCol * f * f;                       // flux is conserved when the min-size clamp spreads a sub-pixel star
  float peak = max(vCol.r, max(vCol.g, vCol.b));
  float sp = smoothstep(30.0, 140.0, peak);  // only the very brightest stars get a faint diffraction starburst
  vec2 d = sb - sa; float L = length(d);
  vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float halo = sigma * (10.0 + 40.0 * sp);
  vec2 c = 0.5 * (sa + sb);
  vec2 loc = vec2(position.x * (0.5 * L + halo), position.y * halo);
  vec2 pos = c + dir * loc.x + nrm * loc.y;
  vLocal = loc; vL = L; vSig = sigma; vC = c; vSp = sp; vHalo = halo;
  gl_Position = vec4(pos / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

export const lightFS = /* glsl */`
varying vec2 vLocal; varying float vL; varying float vSig; varying vec3 vCol; varying vec2 vC; varying float vSp; varying float vHalo;
float erf_(float x) {
  float s = sign(x), a = abs(x), t = 1.0 / (1.0 + 0.3275911 * a);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return s * y;
}
// gaussian blob integrated along the shutter path; peak is divided by streak length (energy conserving)
float streak(vec2 p, float sg, float L) {
  L = max(L, 0.1 * sg);
  float k = 0.70710678 / sg;
  float along = 0.5 * (erf_((p.x + 0.5 * L) * k) - erf_((p.x - 0.5 * L) * k));
  return along * sg * 2.5066283 / L * exp(-0.5 * p.y * p.y / (sg * sg));
}
void main() {
  float sg = vSig;
  float v = streak(vLocal, sg, vL) + 0.02 * streak(vLocal, sg * 2.8, vL);
  // power-law (~1/r^2) glare skirt around the core, faded out before the quad edge
  float dd = length(vec2(max(abs(vLocal.x) - 0.5 * vL, 0.0), vLocal.y));
  float q = dd / (1.6 * sg);
  v += 0.03 / (1.0 + q * q) * (1.0 - smoothstep(0.35, 1.0, dd / vHalo));
  if (vSp > 0.0) {
    vec2 d = gl_FragCoord.xy - vC;
    vec2 u = vec2(d.x + d.y, d.x - d.y) * 0.70710678;
    float w = 0.4 * sg;
    float sx = exp(-0.5 * u.y * u.y / (w * w)) / pow(1.0 + abs(u.x) / (3.0 * sg), 2.0);
    float sy = exp(-0.5 * u.x * u.x / (w * w)) / pow(1.0 + abs(u.y) / (3.0 * sg), 2.0);
    float edge = 1.0 - smoothstep(0.5, 1.0, max(abs(u.x), abs(u.y)) / vHalo);
    v += 0.012 * vSp * (sx + sy) * edge;
  }
  gl_FragColor = vec4(vCol * v, 0.0);
}`;

export const smokeVS = /* glsl */`
attribute vec4 iPosSize; attribute vec2 iRA; attribute vec3 iLit; attribute float iSeed; attribute vec3 iDir; attribute float iAmb;
varying float vAmb; varying vec2 vUV; varying float vAlpha; varying vec3 vLit; varying float vSeed; varying float vRot; varying vec2 vLdir; varying float vPhase;
void main() {
  vec4 vp = viewMatrix * vec4(iPosSize.xyz, 1.0);
  if (vp.z > -1.0) { gl_Position = vec4(3.0, 3.0, 3.0, 1.0); vUV = vec2(0.0); vAlpha = 0.0; vLit = vec3(0.0); vSeed = 0.0; vRot = 0.0; vLdir = vec2(0.0, 1.0); vPhase = 1.0; vAmb = 0.0; return; }
  vp.xy += position.xy * iPosSize.w;
  gl_Position = projectionMatrix * vp;
  vUV = position.xy; vAlpha = iRA.y; vLit = iLit; vSeed = iSeed; vRot = iRA.x; vAmb = iAmb;
  // Henyey-Greenstein forward scattering: brighter when the light source is behind the smoke as seen from the camera
  vec3 V = normalize(iPosSize.xyz - cameraPosition);
  float cs = dot(normalize(iDir), V), g = 0.55;
  float ph = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cs, 1.5);
  vPhase = 0.35 + 0.22 * ph;
  vec2 lv = (viewMatrix * vec4(iDir, 0.0)).xy;
  vLdir = lv / (length(lv) + 1e-3);
}`;

export const smokeFS = /* glsl */`
uniform vec3 uAmbient;
varying float vAmb; varying vec2 vUV; varying float vAlpha; varying vec3 vLit; varying float vSeed; varying float vRot; varying vec2 vLdir; varying float vPhase;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
float gN;
// billowy density: domain-warped fbm inside a soft gaussian envelope (no hard disc edge)
float shape(vec2 uv) {
  float c = cos(vRot), s = sin(vRot);
  vec2 p = mat2(c, -s, s, c) * uv;
  float r = length(uv);
  vec2 q = p * 1.7 + vSeed * 3.17;
  q += 0.6 * (vec2(vn(q * 1.3 + 3.1), vn(q * 1.3 + 7.7)) - 0.5);
  float n1 = fbm(q), n2 = fbm(q * 2.3 + 5.0 + n1 * 1.5);
  gN = n2;
  float d = exp(-3.4 * r * r * (0.75 + 0.7 * (1.0 - n1))) * (1.0 - smoothstep(0.55, 1.0, r));
  return d * (0.05 + 3.2 * n2 * n2);
}
void main() {
  float d0 = shape(vUV), n = gN;
  float d1 = shape(vUV + vLdir * 0.28);               // density between this point and the light
  float a = clamp(vAlpha * d0 * 1.4, 0.0, 1.0);
  float shadow = exp(-3.2 * d1 * min(vAlpha * 6.0, 1.5));   // dense cores shade themselves, rims facing the light stay lit
  float shade = (0.35 + 0.9 * n) * mix(1.0, shadow, 0.85);
  gl_FragColor = vec4((vLit * vPhase * shade + uAmbient * vAmb * (0.55 + 0.9 * n)) * a, a);
}`;

export const fsVS = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export const copyFS = /* glsl */`
uniform sampler2D tex; uniform float uW; varying vec2 vUv;
void main() { gl_FragColor = texture2D(tex, vUv) * uW; }`;

export const downFS = /* glsl */`
uniform sampler2D tex; uniform vec2 uTexel; varying vec2 vUv;
void main() {
  vec2 t = uTexel; vec2 u = vUv;
  vec3 a = texture2D(tex, u + t * vec2(-2, 2)).rgb, b = texture2D(tex, u + t * vec2(0, 2)).rgb, c = texture2D(tex, u + t * vec2(2, 2)).rgb;
  vec3 d = texture2D(tex, u + t * vec2(-2, 0)).rgb, e = texture2D(tex, u).rgb, f = texture2D(tex, u + t * vec2(2, 0)).rgb;
  vec3 g = texture2D(tex, u + t * vec2(-2, -2)).rgb, h = texture2D(tex, u + t * vec2(0, -2)).rgb, i = texture2D(tex, u + t * vec2(2, -2)).rgb;
  vec3 j = texture2D(tex, u + t * vec2(-1, 1)).rgb, k = texture2D(tex, u + t * vec2(1, 1)).rgb;
  vec3 l = texture2D(tex, u + t * vec2(-1, -1)).rgb, m = texture2D(tex, u + t * vec2(1, -1)).rgb;
  vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(o, 1.0);
}`;

export const upFS = /* glsl */`
uniform sampler2D tLow; uniform sampler2D tHigh; uniform vec2 uTexel; uniform float uW; uniform float uHasLow; varying vec2 vUv;
void main() {
  vec3 o = texture2D(tHigh, vUv).rgb * uW;
  if (uHasLow > 0.5) {
    vec2 t = uTexel; vec3 s = vec3(0.0);
    s += texture2D(tLow, vUv + t * vec2(-1, 1)).rgb + texture2D(tLow, vUv + t * vec2(1, 1)).rgb + texture2D(tLow, vUv + t * vec2(-1, -1)).rgb + texture2D(tLow, vUv + t * vec2(1, -1)).rgb;
    s += 2.0 * (texture2D(tLow, vUv + t * vec2(0, 1)).rgb + texture2D(tLow, vUv + t * vec2(0, -1)).rgb + texture2D(tLow, vUv + t * vec2(1, 0)).rgb + texture2D(tLow, vUv + t * vec2(-1, 0)).rgb);
    s += 4.0 * texture2D(tLow, vUv).rgb;
    o += s / 16.0;
  }
  gl_FragColor = vec4(o, 1.0);
}`;

export const compositeFS = /* glsl */`
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform float uExposure; uniform float uBloom; uniform float uMode; uniform float uDither;
varying vec2 vUv;
vec3 aces(vec3 x) { x *= 0.6; return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 oetf(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec4 s = texture2D(tScene, vUv);
  vec3 hdr = (s.rgb + uBloom * texture2D(tBloom, vUv).rgb) * uExposure;
  // hue-preserving tone map (coloured stars keep a saturated body), whitening only the very hot core
  hdr = clamp(hdr, 0.0, 6.0e4);   // keep half-float overflow from turning into NaN
  float hm = max(hdr.r, max(hdr.g, hdr.b));
  float tm = aces(vec3(hm)).r;
  vec3 lin = hdr * (tm / max(hm, 1e-6));
  lin = mix(lin, vec3(tm), smoothstep(5.0, 24.0, hm) * 0.75);   // display-linear light
  float sa = clamp(s.a, 0.0, 1.0);                // smoke coverage
  // uMode 0: luminance alpha = max(smoke, linear emissive max-channel), faded to 0 below 1/1024 (that light stays valid additive data)
  // uMode 1: smoke-only alpha (light adds with alpha 0, so Over == Plus for light), uMode 2: alpha 1 (RGB on black / preview)
  float m = max(lin.r, max(lin.g, lin.b));
  float ea = m * smoothstep(1.0 / 1024.0, 2.0 / 1024.0, m);
  float a = uMode < 0.5 ? max(sa, ea) : (uMode < 1.5 ? sa : 1.0);
  vec3 c = oetf(lin);
  if (uDither > 0.0) {
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
    c = max(c + n / 255.0 * step(0.0005, c), 0.0);
  }
  gl_FragColor = vec4(c, a);
}`;
