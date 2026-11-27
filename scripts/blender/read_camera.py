# Blender (headless): import a glTF and print the first camera as JSON (Blender axes, Z-up).
import bpy, sys, json
path, out = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)
cam = next(o for o in bpy.data.objects if o.type == 'CAMERA')
q = cam.matrix_world.to_quaternion()
json.dump({'location': list(cam.matrix_world.translation), 'quat_wxyz': [q.w, q.x, q.y, q.z], 'lens': cam.data.lens, 'sensor_fit': cam.data.sensor_fit,
           'sensor_w': cam.data.sensor_width, 'sensor_h': cam.data.sensor_height, 'angle_y': cam.data.angle_y, 'angle_x': cam.data.angle_x}, open(out, 'w'))
