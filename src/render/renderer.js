import * as THREE from 'three';
import { Prep, LIGHT_STRIDE, SMOKE_STRIDE } from './prep.js';
import * as SH from './shaders.js';


function quadGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export class FWRenderer {
  constructor(canvas) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.gl.autoClear = false;
    const ext = this.gl.extensions;
    const hasFloat = !!ext.get('EXT_color_buffer_float');
    if (!hasFloat && !ext.get('EXT_color_buffer_half_float')) throw new Error('This browser/GPU cannot render to floating-point textures (EXT_color_buffer_float and EXT_color_buffer_half_float are both missing).');
    // 32-bit float readback target when available; otherwise (or with ?half in the URL) half-float, which still keeps ~11 bits of precision
    this.finalFloat = hasFloat && !new URLSearchParams(location.search).has('half');
    ext.get('EXT_float_blend');
    this.prep = new Prep();
    this.rts = {}; this.k = 'p';
    this.buildScene();
    this.buildPasses();
    this.overlay = null;
  }

  buildScene() {
    const lg = quadGeometry();
    const lb = new THREE.InstancedInterleavedBuffer(this.prep.lights, LIGHT_STRIDE, 1);
    lb.setUsage(THREE.DynamicDrawUsage);
    lg.setAttribute('iP0', new THREE.InterleavedBufferAttribute(lb, 3, 0));
    lg.setAttribute('iP1', new THREE.InterleavedBufferAttribute(lb, 3, 3));
    lg.setAttribute('iCol', new THREE.InterleavedBufferAttribute(lb, 3, 6));
    lg.setAttribute('iSize', new THREE.InterleavedBufferAttribute(lb, 1, 9));
    this.lightBuf = lb; this.lightGeo = lg;
    this.lightMat = new THREE.ShaderMaterial({
      vertexShader: SH.lightVS, fragmentShader: SH.lightFS, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      uniforms: { uRes: { value: new THREE.Vector2() }, uPx: { value: 1 }, uMinSigma: { value: 0.8 } },
    });
    this.smokeMat = new THREE.ShaderMaterial({
      vertexShader: SH.smokeVS, fragmentShader: SH.smokeFS, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: { uAmbient: { value: new THREE.Vector3() } },
    });
    // far smoke is drawn before the stars, near smoke after (it then attenuates the stars behind it)
    const mk = (arr, order) => {
      const g = quadGeometry(), b = new THREE.InstancedInterleavedBuffer(arr, SMOKE_STRIDE, 1);
      b.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('iPosSize', new THREE.InterleavedBufferAttribute(b, 4, 0));
      g.setAttribute('iRA', new THREE.InterleavedBufferAttribute(b, 2, 4));
      g.setAttribute('iLit', new THREE.InterleavedBufferAttribute(b, 3, 6));
      g.setAttribute('iSeed', new THREE.InterleavedBufferAttribute(b, 1, 9));
      g.setAttribute('iDir', new THREE.InterleavedBufferAttribute(b, 3, 10));
      g.setAttribute('iAmb', new THREE.InterleavedBufferAttribute(b, 1, 13));
      const mesh = new THREE.Mesh(g, this.smokeMat); mesh.frustumCulled = false; mesh.renderOrder = order;
      return { g, b, mesh };
    };
    this.smokeFar = mk(this.prep.smokeFar, 0); this.smokeNear = mk(this.prep.smokeNear, 2);
    this.scene = new THREE.Scene();
    this.lightMesh = new THREE.Mesh(lg, this.lightMat); this.lightMesh.frustumCulled = false; this.lightMesh.renderOrder = 1;
    this.scene.add(this.smokeFar.mesh, this.lightMesh, this.smokeNear.mesh);
  }

  buildPasses() {
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsScene = new THREE.Scene();
    this.fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.fsMesh.frustumCulled = false; this.fsScene.add(this.fsMesh);
    const m = (fs, uniforms, blending) => new THREE.ShaderMaterial({ vertexShader: SH.fsVS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false, blending: blending ?? THREE.NoBlending });
    this.copyMat = m(SH.copyFS, { tex: { value: null }, uW: { value: 1 } }, THREE.CustomBlending);
    this.copyMat.blendEquation = THREE.AddEquation; this.copyMat.blendSrc = THREE.OneFactor; this.copyMat.blendDst = THREE.OneFactor;
    this.copyMat.blendSrcAlpha = THREE.OneFactor; this.copyMat.blendDstAlpha = THREE.OneFactor;
    this.downMat = m(SH.downFS, { tex: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upMat = m(SH.upFS, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uW: { value: 1 }, uHasLow: { value: 0 } });
    this.compMat = m(SH.compositeFS, { tScene: { value: null }, tBloom: { value: null }, uExposure: { value: 1 }, uBloom: { value: 0.2 }, uMode: { value: 2 }, uDither: { value: 0 } });
  }

  rt(name, w, h, type = THREE.HalfFloatType) {
    name = this.k + name;
    let r = this.rts[name];
    if (!r || r.width !== w || r.height !== h) {
      r?.dispose();
      r = new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false });
      r.texture.generateMipmaps = false;
      this.rts[name] = r;
    }
    return r;
  }

  pass(mat, target) {
    this.fsMesh.material = mat;
    this.gl.setRenderTarget(target);
    this.gl.render(this.fsScene, this.fsCam);
  }

  // Multi-scale glare. Level textures have FIXED widths (960, 480, ... 15 px) at every output resolution, so each level's
  // blur width is the same fraction of the frame whether the render is 720p, 1080p or 4K (high-res sources are pre-halved
  // first). Level weights fall off as rho^level (a power-law-like PSF) and are normalised to sum to 1, so the glare term
  // carries the scene's energy scaled by bloomStrength.
  bloom(src, w, h, rp) {
    const levels = 7, refW = 960, down = [];
    let prev = src, pw = w, ph = h, pre = 0;
    const step = (name, tw, th) => {   // 13-tap dual-filter downsample from the current source
      const d = this.rt(name, tw, th);
      this.downMat.uniforms.tex.value = prev; this.downMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      this.pass(this.downMat, d); prev = d.texture; pw = tw; ph = th; return d;
    };
    for (let i = 0; i < levels; i++) {
      const tw = refW >> i, th = Math.max(2, Math.round(tw * h / w));
      while (pw > 2.01 * tw) step('bp' + pre++, Math.max(2, pw >> 1), Math.max(2, ph >> 1));   // keep every filter step close to 2x
      down.push(step('bd' + i, tw, th));
    }
    const rho = 0.35 + 0.65 * rp.bloomRadius;
    let ws = 0; const wts = []; for (let i = 0; i < levels; i++) { wts.push(Math.pow(rho, i)); ws += wts[i]; }
    let low = null;
    for (let i = levels - 1; i >= 0; i--) {
      const t = down[i], u = this.rt('bu' + i, t.width, t.height);
      this.upMat.uniforms.tHigh.value = t.texture; this.upMat.uniforms.uW.value = wts[i] / ws;
      this.upMat.uniforms.uHasLow.value = low ? 1 : 0; this.upMat.uniforms.tLow.value = low ? low.texture : null;
      if (low) this.upMat.uniforms.uTexel.value.set(1 / low.width, 1 / low.height);
      this.pass(this.upMat, u); low = u;
    }
    return low.texture;
  }

  // samples: [[ta, tb], ...] shutter sub-intervals in sim seconds. Renders into `target`
  // ('screen' = canvas, 'float' = 32F offscreen target returned for readback).
  render(world, camera, o) {
    const { width: w, height: h, samples, el, rp, target } = o;
    const gl = this.gl, P = this.prep;
    this.k = target === 'screen' ? 'p' : 'x';
    camera.aspect = w / h; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    const cam = { fwd: [fwd.x, fwd.y, fwd.z], pos: [camera.position.x, camera.position.y, camera.position.z] };
    const scene = this.rt('scene', w, h);
    const accum = samples.length > 1 ? this.rt('accum', w, h) : null;
    const px = (o.frameH || h) / 1080;
    this.lightMat.uniforms.uRes.value.set(w, h); this.lightMat.uniforms.uPx.value = px;
    this.lightMat.uniforms.uMinSigma.value = rp.minStarSize;
    this.smokeMat.uniforms.uAmbient.value.set(0.75, 0.9, 1.2).multiplyScalar(rp.smokeAmbient);
    gl.setViewport(0, 0, w, h);
    if (accum) { gl.setRenderTarget(accum); gl.setClearColor(0x000000, 0); gl.clear(true, false, false); }
    for (let i = 0; i < samples.length; i++) {
      const [ta, tb] = samples[i];
      world.advanceTo(tb);
      P.buildLights(world, ta, tb, el, rp.starGain, o.lod || 1);
      this.lightBuf.clearUpdateRanges(); this.lightBuf.addUpdateRange(0, Math.max(1, P.nLights * LIGHT_STRIDE)); this.lightBuf.needsUpdate = true;
      this.lightGeo.instanceCount = P.nLights;
      if (el.smoke) P.buildSmoke(world, tb, cam, rp.smokeDensity, rp.smokeLight * 27, el); else { P.nFar = 0; P.nNear = 0; }
      for (const [sm, n] of [[this.smokeFar, P.nFar], [this.smokeNear, P.nNear]]) {
        sm.b.clearUpdateRanges(); sm.b.addUpdateRange(0, Math.max(1, n * SMOKE_STRIDE)); sm.b.needsUpdate = true;
        sm.g.instanceCount = n; sm.mesh.visible = n > 0;
      }
      gl.setRenderTarget(scene); gl.setClearColor(0x000000, 0); gl.clear(true, false, false);
      gl.render(this.scene, camera);
      if (accum) {
        this.copyMat.uniforms.tex.value = scene.texture; this.copyMat.uniforms.uW.value = 1 / samples.length;
        this.pass(this.copyMat, accum);
      }
    }
    const hdr = accum || scene;
    const bloomOn = el.glow && rp.bloomStrength > 0;
    const bloomTex = bloomOn ? this.bloom(hdr.texture, w, h, rp) : hdr.texture;
    const u = this.compMat.uniforms;
    u.tScene.value = hdr.texture; u.tBloom.value = bloomTex; u.uExposure.value = Math.pow(2, rp.exposure);
    u.uBloom.value = bloomOn ? rp.bloomStrength : 0; u.uMode.value = target === 'screen' || o.alpha === 'black' ? 2 : o.alpha === 'smoke' ? 1 : 0;
    u.uDither.value = target === 'screen' ? 1 : 0;
    gl.setClearColor(0x000000, 1);
    if (target === 'screen') {
      gl.setRenderTarget(null); gl.setViewport(0, 0, w, h); gl.clear(true, false, false);
      this.pass(this.compMat, null);
      if (o.overlay) { gl.setRenderTarget(null); gl.render(o.overlay, camera); }
      return null;
    }
    const fin = this.rt('final', w, h, this.finalFloat ? THREE.FloatType : THREE.HalfFloatType);
    gl.setClearColor(0x000000, 0); gl.setRenderTarget(fin); gl.clear(true, false, false);
    this.pass(this.compMat, fin);
    return fin;
  }

  readFloat(fin, buf) {
    if (fin.texture.type === THREE.FloatType) { this.gl.readRenderTargetPixels(fin, 0, 0, fin.width, fin.height, buf); return buf; }
    const h16 = this.half16 && this.half16.length === buf.length ? this.half16 : (this.half16 = new Uint16Array(buf.length));
    this.gl.readRenderTargetPixels(fin, 0, 0, fin.width, fin.height, h16);
    for (let i = 0; i < buf.length; i++) buf[i] = THREE.DataUtils.fromHalfFloat(h16[i]);
    return buf;
  }

  info() {
    const g = this.gl.getContext(), ext = g.getExtension('WEBGL_debug_renderer_info');
    return { renderer: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown', webgl2: this.gl.capabilities.isWebGL2 };
  }
}
