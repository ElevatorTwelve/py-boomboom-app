# Blender (headless): a cube plus a camera at a known pose, exported as GLB or glTF-separate (.gltf + .bin).
import bpy, sys, math
out, fmt = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=20, location=(0, 0, 150))
cd = bpy.data.cameras.new('BlenderCam'); cd.sensor_fit = 'VERTICAL'; cd.sensor_height = 20.25; cd.lens = 35
co = bpy.data.objects.new('BlenderCam', cd); bpy.context.scene.collection.objects.link(co)
co.location = (30, -400, 25); co.rotation_euler = (math.radians(88), 0, math.radians(5))
bpy.context.scene.render.resolution_x = 1920; bpy.context.scene.render.resolution_y = 1080
bpy.ops.export_scene.gltf(filepath=out, export_format=fmt, export_cameras=True, use_selection=False)
