# Blender (headless): import a glTF with an animated camera and print its pose at the given output frames (0 = first frame of the file), Blender axes.
import bpy, sys, json
path, out, fps = sys.argv[sys.argv.index('--') + 1:][:3]
frames = [int(x) for x in sys.argv[sys.argv.index('--') + 4:]]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = int(fps)
bpy.ops.import_scene.gltf(filepath=path)
cam = next(o for o in bpy.data.objects if o.type == 'CAMERA')
act = cam.animation_data.action if cam.animation_data else None
start = int(round(act.frame_range[0])) if act else 0
res = {'frame_start': start, 'frame_end': int(round(act.frame_range[1])) if act else 0, 'poses': []}
for f in frames:
    bpy.context.scene.frame_set(start + f)
    q = cam.matrix_world.to_quaternion()
    res['poses'].append({'f': f, 'location': list(cam.matrix_world.translation), 'quat_wxyz': [q.w, q.x, q.y, q.z]})
json.dump(res, open(out, 'w'))
