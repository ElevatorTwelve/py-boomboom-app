# PY-BoomBoom: save the active camera of the Blender scene, with its animation, as a .glb that PY-BoomBoom can import.
#
# In Blender: open the Scripting workspace, open this file, click Run Script, and choose where to save.
# Headless:   blender --background scene.blend --python export_camera.py -- camera.glb
#
# The camera is baked: one key for every frame from the scene start frame to the end frame (location and rotation in world space,
# parents applied). glTF cannot animate the field of view, so the vertical field of view of every frame is written to
# extras.pyBoomBoomCamera.fovDegrees. The vertical field of view comes from the real camera, its sensor fit and the render resolution.
# Scene units must be metres (the default).
# The scene scale, origin and sensor height of PY-BoomBoom are written only when the camera came from a PY-BoomBoom import (the import script
# remembers them on the camera object); then the file says source 'PY-BoomBoom' and PY-BoomBoom adopts them. Any other camera is written as
# source 'Blender' and PY-BoomBoom keeps its own "1 unit = X m" and Origin settings.
import bpy
import math
import sys

EXTRAS_KEY = 'pyBoomBoomCamera'
SENSOR_HEIGHT_MM = 20.25


def vertical_fov(cam, scene):
    """Vertical field of view in radians, from the lens, the sensor fit and the render aspect ratio."""
    r = scene.render
    aspect = (r.resolution_x * r.pixel_aspect_x) / (r.resolution_y * r.pixel_aspect_y)
    fit = cam.sensor_fit
    if fit == 'AUTO':
        fit = 'HORIZONTAL' if aspect >= 1 else 'VERTICAL'
        sensor = cam.sensor_width
    else:
        sensor = cam.sensor_width if fit == 'HORIZONTAL' else cam.sensor_height
    angle = 2 * math.atan(sensor / 2 / cam.lens)
    if fit == 'HORIZONTAL':
        return 2 * math.atan(math.tan(angle / 2) / aspect)
    return angle


def do_export(path):
    scene = bpy.context.scene
    source = scene.camera
    if source is None:
        raise RuntimeError('The scene has no active camera. Set one first (View > Cameras > Set Active Object as Camera).')
    fps = scene.render.fps / scene.render.fps_base
    start, end = scene.frame_start, scene.frame_end
    original_frame = scene.frame_current

    poses, fovs = [], []
    for f in range(start, end + 1):
        scene.frame_set(f)
        m = source.matrix_world.copy()
        loc, quat, _scale = m.decompose()
        poses.append((loc.copy(), quat.copy()))
        fovs.append(math.degrees(vertical_fov(source.data, scene)))
    scene.frame_set(original_frame)

    carried = 'pyb_metresPerUnit' in source
    sensor_height = float(source.get('pyb_sensorHeight', SENSOR_HEIGHT_MM)) if carried else SENSOR_HEIGHT_MM
    cam_data = bpy.data.cameras.new('PYB_export_camera')
    cam_data.sensor_fit = 'VERTICAL'
    cam_data.sensor_height = sensor_height
    cam_data.lens = sensor_height / 2 / math.tan(math.radians(fovs[0]) / 2)
    cam_data.clip_start = source.data.clip_start
    cam_data.clip_end = source.data.clip_end
    obj = bpy.data.objects.new(source.name, cam_data)
    scene.collection.objects.link(obj)
    obj.rotation_mode = 'QUATERNION'

    prefs = bpy.context.preferences.edit
    saved = prefs.keyframe_new_interpolation_type
    prefs.keyframe_new_interpolation_type = 'LINEAR'
    try:
        previous = None
        for i, (loc, quat) in enumerate(poses):
            if previous is not None and previous.dot(quat) < 0:
                quat = -quat
            previous = quat.copy()
            obj.location = loc
            obj.rotation_quaternion = quat
            if len(poses) > 1:
                obj.keyframe_insert('location', frame=start + i)
                obj.keyframe_insert('rotation_quaternion', frame=start + i)
        if len(poses) == 1:
            obj.location, obj.rotation_quaternion = poses[0]
    finally:
        prefs.keyframe_new_interpolation_type = saved

    extras = {
        'version': 1, 'source': 'PY-BoomBoom' if carried else 'Blender', 'fps': fps, 'frameCount': len(poses),
        'width': scene.render.resolution_x, 'height': scene.render.resolution_y,
        'aspect': scene.render.resolution_x / scene.render.resolution_y,
        'sensorHeightMm': sensor_height, 'focalMm': float(cam_data.lens),
    }
    if carried:
        extras['metresPerUnit'] = float(source['pyb_metresPerUnit'])
        extras['unitsPerMetre'] = 1.0 / extras['metresPerUnit']
        extras['originMetres'] = [float(v) for v in source.get('pyb_originMetres', (0.0, 0.0, 0.0))]
    if len(fovs) > 1:
        extras['fovDegrees'] = fovs
    obj[EXTRAS_KEY] = extras
    cam_data[EXTRAS_KEY] = extras

    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    props = bpy.ops.export_scene.gltf.get_rna_type().properties
    wanted = {
        'filepath': path, 'export_format': 'GLB', 'use_selection': True, 'export_cameras': True, 'export_extras': True,
        'export_yup': True, 'export_animations': True, 'export_force_sampling': True, 'export_apply': False,
        'export_frame_range': False, 'export_animation_mode': 'ACTIONS',
    }
    bpy.ops.export_scene.gltf(**{k: v for k, v in wanted.items() if k in props})

    bpy.data.objects.remove(obj)
    bpy.data.cameras.remove(cam_data)
    scene.frame_set(original_frame)
    print('PY-BoomBoom camera exported: %s, %d frames, %.3f fps' % (path, len(poses), fps))


class PYB_OT_export_camera(bpy.types.Operator):
    bl_idname = 'export_scene.py_boomboom_camera'
    bl_label = 'Export PY-BoomBoom camera'
    filepath: bpy.props.StringProperty(subtype='FILE_PATH')
    filename_ext = '.glb'
    filter_glob: bpy.props.StringProperty(default='*.glb', options={'HIDDEN'})

    def execute(self, context):
        try:
            do_export(bpy.path.ensure_ext(self.filepath, '.glb'))
        except Exception as err:
            self.report({'ERROR'}, str(err))
            return {'CANCELLED'}
        return {'FINISHED'}

    def invoke(self, context, event):
        self.filepath = 'camera.glb'
        context.window_manager.fileselect_add(self)
        return {'RUNNING_MODAL'}


if '--' in sys.argv and sys.argv[sys.argv.index('--') + 1:]:
    do_export(sys.argv[sys.argv.index('--') + 1])
else:
    try:
        bpy.utils.register_class(PYB_OT_export_camera)
    except ValueError:
        bpy.utils.unregister_class(PYB_OT_export_camera)
        bpy.utils.register_class(PYB_OT_export_camera)
    bpy.ops.export_scene.py_boomboom_camera('INVOKE_DEFAULT')
