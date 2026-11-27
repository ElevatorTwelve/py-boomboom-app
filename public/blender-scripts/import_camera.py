# PY-BoomBoom: load a camera exported from PY-BoomBoom (.glb or .gltf) into Blender, with its animation.
#
# In Blender: open the Scripting workspace, open this file, click Run Script, and choose the file.
# Headless:   blender --background --python import_camera.py -- camera.glb [report.json]
#
# It sets the scene frame rate, the frame range and the resolution, makes the camera active, uses a vertical sensor fit with the
# sensor height from the file (20.25 mm by default), and keys the focal length for every frame (glTF cannot animate the field of view).
# Scene units must be metres (the default).
import bpy
import json
import math
import struct
import sys

EXTRAS_KEY = 'pyBoomBoomCamera'


def read_gltf_json(path):
    """The JSON part of a .glb or .gltf file."""
    with open(path, 'rb') as f:
        data = f.read()
    if data[:4] == b'glTF':
        length, kind = struct.unpack_from('<II', data, 12)
        return json.loads(data[20:20 + length].decode('utf-8'))
    return json.loads(data.decode('utf-8'))


def first_camera_info(doc):
    """Extras written by PY-BoomBoom and the yfov (radians) of the first camera node, or ({}, None)."""
    for node in doc.get('nodes', []):
        if 'camera' not in node:
            continue
        cam = doc.get('cameras', [])[node['camera']]
        extras = node.get('extras', {}).get(EXTRAS_KEY) or cam.get('extras', {}).get(EXTRAS_KEY) or {}
        return extras, cam.get('perspective', {}).get('yfov')
    return {}, None


def set_frame_rate(scene, fps):
    whole = round(fps)
    scene.render.fps = whole
    scene.render.fps_base = whole / fps if fps else 1.0


def do_import(path):
    doc = read_gltf_json(path)
    extras, yfov = first_camera_info(doc)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    cams = [o for o in bpy.data.objects if o not in before and o.type == 'CAMERA']
    if not cams:
        raise RuntimeError('There is no camera in the file. Export it with the camera included.')
    obj = cams[0]
    cam = obj.data
    scene = bpy.context.scene

    sensor_h = float(extras.get('sensorHeightMm', 20.25))
    cam.sensor_fit = 'VERTICAL'
    cam.sensor_height = sensor_h
    fovs = extras.get('fovDegrees')
    fov0 = math.radians(fovs[0]) if fovs else yfov
    if fov0:
        cam.lens = sensor_h / 2 / math.tan(fov0 / 2)

    if extras.get('fps'):
        set_frame_rate(scene, float(extras['fps']))
    if extras.get('width') and extras.get('height'):
        scene.render.resolution_x = int(extras['width'])
        scene.render.resolution_y = int(extras['height'])
        scene.render.resolution_percentage = 100

    action = obj.animation_data.action if obj.animation_data else None
    start = int(round(action.frame_range[0])) if action else scene.frame_start
    count = int(extras.get('frameCount') or (round(action.frame_range[1] - action.frame_range[0]) + 1 if action else 1))
    scene.frame_start = start
    scene.frame_end = start + count - 1
    scene.frame_set(start)

    if fovs and len(fovs) > 1:
        prefs = bpy.context.preferences.edit
        saved = prefs.keyframe_new_interpolation_type
        prefs.keyframe_new_interpolation_type = 'LINEAR'
        try:
            for i, fov in enumerate(fovs):
                cam.lens = sensor_h / 2 / math.tan(math.radians(fov) / 2)
                cam.keyframe_insert('lens', frame=start + i)
        finally:
            prefs.keyframe_new_interpolation_type = saved
        scene.frame_set(start)

    if 'metresPerUnit' in extras:
        obj['pyb_metresPerUnit'] = float(extras['metresPerUnit'])
    if 'originMetres' in extras:
        obj['pyb_originMetres'] = [float(v) for v in extras['originMetres']]
    obj['pyb_sensorHeight'] = sensor_h
    scene.camera = obj
    print('PY-BoomBoom camera imported: %s, %d frames, %s fps, lens %.3f mm, sensor height %.2f mm'
          % (obj.name, count, extras.get('fps', scene.render.fps), cam.lens, sensor_h))
    return obj


def report(obj, out):
    scene = bpy.context.scene
    frames = sorted({scene.frame_start, (scene.frame_start + scene.frame_end) // 2, scene.frame_end})
    rows = []
    for f in frames:
        scene.frame_set(f)
        m = obj.matrix_world
        q = m.to_quaternion()
        rows.append({'frame': f, 'location': list(m.translation), 'quat_wxyz': [q.w, q.x, q.y, q.z], 'lens': obj.data.lens,
                     'angle_y': obj.data.angle_y})
    with open(out, 'w') as fh:
        json.dump({'frame_start': scene.frame_start, 'frame_end': scene.frame_end, 'fps': scene.render.fps / scene.render.fps_base,
                   'resolution': [scene.render.resolution_x, scene.render.resolution_y], 'sensor_fit': obj.data.sensor_fit,
                   'sensor_height': obj.data.sensor_height, 'active': scene.camera == obj, 'rows': rows}, fh)


class PYB_OT_import_camera(bpy.types.Operator):
    bl_idname = 'import_scene.py_boomboom_camera'
    bl_label = 'Import PY-BoomBoom camera'
    filepath: bpy.props.StringProperty(subtype='FILE_PATH')
    filter_glob: bpy.props.StringProperty(default='*.glb;*.gltf', options={'HIDDEN'})

    def execute(self, context):
        try:
            do_import(self.filepath)
        except Exception as err:
            self.report({'ERROR'}, str(err))
            return {'CANCELLED'}
        return {'FINISHED'}

    def invoke(self, context, event):
        context.window_manager.fileselect_add(self)
        return {'RUNNING_MODAL'}


if '--' in sys.argv:
    args = sys.argv[sys.argv.index('--') + 1:]
    if args:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        imported = do_import(args[0])
        if len(args) > 1:
            report(imported, args[1])
else:
    try:
        bpy.utils.register_class(PYB_OT_import_camera)
    except ValueError:
        bpy.utils.unregister_class(PYB_OT_import_camera)
        bpy.utils.register_class(PYB_OT_import_camera)
    bpy.ops.import_scene.py_boomboom_camera('INVOKE_DEFAULT')
