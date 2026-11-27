// Camera exchange with Blender through glTF (.glb is best; .gltf with the data inside also works). Blender reads and writes glTF from
// File > Import / Export, and it converts the axes (glTF is Y-up, Blender is Z-up) by itself. Position, orientation (so roll) and field of view travel.
// With a camera animation the file holds one pose per export frame. Set the Blender frame rate to the export fps so frame N matches frame N.
// glTF cannot animate the field of view; PY-BoomBoom stores it in the file extras, Blender ignores it and uses one lens for the whole shot.
import { state } from '../state.js';
import { encodeCameraGltf, parseGltf, listCameras, readCamera, SENSOR_HEIGHT_MM } from '../camera/gltf.js';
import { bakeFrames, hasCamera, cameraLength, fovOfFocal } from '../camera/path.js';

// The camera as frames: the camera animation when there is one, else the view on the screen (a single frame, roll included).
export function cameraFrames(app) {
  const fps = state.export.fps;
  if (hasCamera(state.camera)) return { frames: bakeFrames(state.camera, fps), fps };
  const rg = app.rig; rg.camera.updateMatrixWorld();
  return { frames: [{ position: rg.camera.position.toArray(), quaternion: rg.camera.quaternion.toArray(), fov: fovOfFocal(rg.focal) }], fps };
}

export function exportCamera(app, format = 'glb') {
  const { frames, fps } = cameraFrames(app);
  return encodeCameraGltf({ name: 'PY-BoomBoom camera', fps, frames, frameCount: frames.length, width: state.export.width, height: state.export.height, sensorHeight: SENSOR_HEIGHT_MM, metresPerUnit: 1, originMetres: [0, 0, 0], format });
}

// Read a glTF file and make it the camera animation. A still camera becomes one frame, so its roll is kept.
export function importCamera(app, data) {
  const doc = parseGltf(data), cams = listCameras(doc);
  if (!cams.length) throw new Error('No camera in the file. In Blender, tick Include > Cameras when you export glTF.');
  const fps = state.export.fps, cam = readCamera(doc, cams[0].node, { fps, metresPerUnit: 1, originMetres: [0, 0, 0], useFileScale: false });
  const n = cam.frames.length;
  state.camera.baked = {
    id: Date.now() + Math.random(), name: cam.name, fps, count: n,
    position: cam.frames.flatMap((f) => f.position), quaternion: cam.frames.flatMap((f) => f.quaternion), fov: cam.frames.map((f) => f.fov),
  };
  const had = state.camera.keys.length;
  state.camera.keys = []; state.camera.view = 'shot';
  app.camAnim?.rebuild();
  return { name: cam.name, frames: n, fps, animated: cam.animated, replacedKeys: had, extra: cams.length > 1 ? `${cams.length} cameras found; used the first` : '' };
}

const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };

export function buildBlenderCameraUI(fCam, app, refresh) {
  const f = fCam.addFolder('Blender camera (glTF)').close();
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.gltf,.glb'; input.style.display = 'none'; document.body.append(input);
  const send = () => {
    try {
      const o = exportCamera(app, 'glb'), animated = hasCamera(state.camera) && cameraLength(state.camera) > 0;
      download(new Blob([o.data], { type: o.mime }), 'py-boomboom-camera.glb');
      app.notify(`Saved py-boomboom-camera.glb (${animated ? 'animated, ' + state.export.fps + ' fps' : 'still'}). In Blender: File > Import > glTF 2.0` + (animated ? ', and set the frame rate to ' + state.export.fps + ' fps' : ''));
    } catch (e) { app.notify('Camera save failed: ' + e.message); }
  };
  input.addEventListener('change', async () => {
    const file = input.files[0]; input.value = ''; if (!file) return;
    try {
      const r = importCamera(app, /\.gltf$/i.test(file.name) ? await file.text() : await file.arrayBuffer());
      refresh?.(); app.notify(`Imported camera "${r.name}": ${r.frames} frame${r.frames > 1 ? 's' : ''}` + (r.animated ? ` at ${r.fps} fps` : '') + (r.replacedKeys ? `. Replaced ${r.replacedKeys} camera keys` : '') + (r.extra ? ' - ' + r.extra : ''));
    } catch (e) { app.notify('Camera import failed: ' + e.message); }
  });
  f.add({ f: send }, 'f').name('Send camera to Blender (.glb)');
  f.add({ f: () => input.click() }, 'f').name('Get camera from Blender (.glb / .gltf)');
  // Helper scripts for Blender (public/blender-scripts): the load script sets the frame rate, size, frame range and keys the lens;
  // the save script writes the camera, with its lens animation, as a .glb that this app reads.
  const getScript = async (name) => {
    try { const r = await fetch('/blender-scripts/' + name); if (!r.ok) throw new Error('not found'); download(new Blob([await r.text()], { type: 'text/x-python' }), name); app.notify(`Saved ${name}. In Blender: Scripting workspace > Open > Run Script.`); }
    catch (e) { app.notify(`Could not get ${name}: ${e.message}`); }
  };
  f.add({ f: () => getScript('import_camera.py') }, 'f').name('Get Blender script: load camera');
  f.add({ f: () => getScript('export_camera.py') }, 'f').name('Get Blender script: save camera');
  return { exportCamera: (fmt) => exportCamera(app, fmt), importCamera: (data) => importCamera(app, data), cameraFrames: () => cameraFrames(app) };
}
