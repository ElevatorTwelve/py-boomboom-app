# Blender (headless): an animated camera (24 fps, frames 1 to 25, with roll) exported as GLB. Also writes its poses at frames 1, 13, 25 (Blender axes).
import bpy, sys, math, json
out, info = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene; sc.render.fps = 24; sc.frame_start = 1; sc.frame_end = 25
sc.render.resolution_x = 1920; sc.render.resolution_y = 1080
cd = bpy.data.cameras.new('AnimCam'); cd.sensor_fit = 'VERTICAL'; cd.sensor_height = 20.25; cd.lens = 35
co = bpy.data.objects.new('AnimCam', cd); sc.collection.objects.link(co)
co.rotation_mode = 'XYZ'
bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
co.location = (0, -520, 6); co.rotation_euler = (math.radians(88), math.radians(0), 0); co.keyframe_insert('location', frame=1); co.keyframe_insert('rotation_euler', frame=1)
co.location = (200, -300, 60); co.rotation_euler = (math.radians(84), math.radians(25), math.radians(40)); co.keyframe_insert('location', frame=25); co.keyframe_insert('rotation_euler', frame=25)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_cameras=True, export_animations=True, use_selection=False)
poses = []
for f in (1, 13, 25):
    sc.frame_set(f); q = co.matrix_world.to_quaternion()
    poses.append({'f': f - 1, 'location': list(co.matrix_world.translation), 'quat_wxyz': [q.w, q.x, q.y, q.z]})
json.dump(poses, open(info, 'w'))
