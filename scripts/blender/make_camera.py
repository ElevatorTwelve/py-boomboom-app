# Blender (headless): build a camera at a known pose, export it as glTF with cameras included.
import bpy, sys, math
out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
cd = bpy.data.cameras.new('BlenderCam'); cd.sensor_fit = 'VERTICAL'; cd.sensor_height = 20.25; cd.lens = 35
co = bpy.data.objects.new('BlenderCam', cd); bpy.context.scene.collection.objects.link(co)
co.location = (30, -400, 25)               # Blender: X right, Y forward (into the scene), Z up
co.rotation_euler = (math.radians(88), 0, math.radians(5))
bpy.context.scene.render.resolution_x = 1920; bpy.context.scene.render.resolution_y = 1080
bpy.ops.export_scene.gltf(filepath=out, export_format='GLTF_SEPARATE', export_cameras=True, use_selection=False)
