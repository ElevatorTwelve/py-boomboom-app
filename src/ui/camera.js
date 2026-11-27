import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SENSOR_H, VIEWS } from '../state.js';

const D2R = Math.PI / 180;
const FORWARD = new THREE.Vector3(0, 0, -1);

// The camera you look through. It is either free (Perspective view) or the shot camera (Camera view): the same orbit, pan, zoom and fly
// controls work in both. In the Camera view a finished edit calls onUserEdit (the app then sets a key, or marks the edit as not keyed).
export class CameraRig {
  constructor(dom) {
    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.5, 20000);
    this.dom = dom;
    this.focal = 60;
    this.roll = 0;          // degrees, about the view axis; applied after orbit / fly, so it survives them
    this.fly = false;
    this.dragging = false;  // an orbit / pan / zoom gesture is running
    this.flyHeld = false;   // a fly key or the fly mouse look is active
    this.editTimer = null;
    this.onUserEdit = null; // called 150 ms after the last user camera change
    this.onInteractStart = null;
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.screenSpacePanning = true;
    this.controls.zoomSpeed = 1.2;
    this.controls.addEventListener('start', () => { this.dragging = true; this.onInteractStart?.(); });
    this.controls.addEventListener('end', () => { this.dragging = false; this.edited(); });
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0;
    this.apply(VIEWS.Default);
    const typing = (e) => /input|textarea|select/i.test(e.target.tagName);
    addEventListener('keydown', (e) => { if (this.fly && !typing(e)) this.keys.add(e.code); });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    dom.addEventListener('pointerdown', () => { if (this.fly) { this.flyHeld = true; this.onInteractStart?.(); } });
    addEventListener('pointerup', () => { if (this.flyHeld) { this.flyHeld = false; this.edited(); } });
    dom.addEventListener('pointermove', (e) => {
      if (!this.fly || !(e.buttons & 1)) return;
      this.yaw -= e.movementX * 0.002 * (this.camera.fov / 30); this.pitch -= e.movementY * 0.002 * (this.camera.fov / 30);
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
      this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
      this.edited();
    });
  }

  // True while the user is moving the camera (or a moment after), so the animation must not move it.
  get interacting() { return this.dragging || this.flyHeld || this.editTimer !== null; }

  // The user changed the camera (orbit, fly, a number in the panel). Debounced: onUserEdit runs once the movement has stopped.
  edited() {
    clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => { this.editTimer = null; this.onUserEdit?.(); }, 150);
  }

  setFocal(mm) {
    this.focal = mm;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(SENSOR_H / 2 / mm));
    this.camera.updateProjectionMatrix();
  }

  apply(v) {
    if (v.position) this.camera.position.set(...v.position);
    if (v.focal) this.setFocal(v.focal);
    this.roll = v.roll ?? 0;
    if (v.target) { this.controls.target.set(...v.target); this.camera.lookAt(this.controls.target); }
    this.syncAngles();
    if (!this.fly) this.controls.update();   // in fly mode the view direction is owned by yaw/pitch
    this.applyRoll();
  }

  syncAngles() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y; this.pitch = e.x;
  }

  applyRoll() {   // call right after the orientation was built from position and target (or yaw and pitch)
    if (!this.roll) return;
    this.camera.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(FORWARD, this.roll * D2R));
  }

  setFly(on) {
    this.fly = on; this.controls.enabled = !on;
    if (on) this.syncAngles();
    else {
      const f = new THREE.Vector3(); this.camera.getWorldDirection(f);
      this.controls.target.copy(this.camera.position).addScaledVector(f, Math.max(50, this.controls.target.distanceTo(this.camera.position)));
      this.controls.update();
    }
  }

  // Shot camera: take the pose of the animation (position, target, focal length, roll). Orbit and fly keep working from this pose.
  drive(p) {
    this.camera.position.set(...p.position); this.controls.target.set(...p.target); this.roll = p.roll || 0;
    this.setFocal(p.focal);
    this.camera.lookAt(this.controls.target); this.syncAngles();   // update() builds the final orientation, roll included
  }

  update(dt) {
    if (this.fly) {
      const k = this.keys, f = new THREE.Vector3(), r = new THREE.Vector3();
      this.camera.getWorldDirection(f); r.crossVectors(f, this.camera.up).normalize();
      const sp = (k.has('ShiftLeft') ? 160 : 40) * dt, m = new THREE.Vector3();
      if (k.has('KeyW')) m.add(f); if (k.has('KeyS')) m.sub(f);
      if (k.has('KeyD')) m.add(r); if (k.has('KeyA')) m.sub(r);
      if (k.has('KeyE')) m.y += 1; if (k.has('KeyQ')) m.y -= 1;
      if (m.lengthSq() > 0) { if (!this.flyMoving) this.onInteractStart?.(); this.flyMoving = true; this.edited(); } else this.flyMoving = false;
      this.camera.position.addScaledVector(m, sp);
      this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    } else this.controls.update();
    this.applyRoll();
    this.camera.updateMatrixWorld();
  }

  // Everything needed to reproduce the exact framing: position, orientation, focal length, roll and control mode
  capture() {
    const f = new THREE.Vector3(); this.camera.getWorldDirection(f);
    const t = this.fly ? this.camera.position.clone().addScaledVector(f, 100) : this.controls.target;
    return { position: this.camera.position.toArray(), target: t.toArray(), quaternion: this.camera.quaternion.toArray(), focal: this.focal, roll: this.roll, mode: this.fly ? 'fly' : 'orbit' };
  }

  applyPreset(p) {
    this.setFly(false);
    this.roll = p.roll || 0;
    this.camera.position.set(...p.position);
    this.controls.target.set(...(p.target || [0, 160, 0]));
    this.setFocal(p.focal);
    this.camera.lookAt(this.controls.target);
    this.syncAngles(); this.controls.update();
    if (p.mode === 'fly') { this.setFly(true); if (p.quaternion) this.camera.quaternion.set(...p.quaternion); this.syncAngles(); }
    this.applyRoll();
    this.camera.updateMatrixWorld();
  }

  get() {
    const f = new THREE.Vector3(); this.camera.getWorldDirection(f);
    const t = this.fly ? this.camera.position.clone().addScaledVector(f, 100) : this.controls.target;
    return { position: this.camera.position.toArray(), target: t.toArray(), focal: this.focal, roll: this.roll };
  }
}
