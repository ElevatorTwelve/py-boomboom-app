# Blender (headless): a scene whose camera lens is animated (35 mm to 70 mm over frames 1 to 25 at 24 fps), saved as a .blend file.
import bpy, sys, math
out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene; sc.render.fps = 24; sc.frame_start = 1; sc.frame_end = 25
sc.render.resolution_x = 1280; sc.render.resolution_y = 720
cd = bpy.data.cameras.new('ZoomCam'); cd.sensor_fit = 'VERTICAL'; cd.sensor_height = 20.25
co = bpy.data.objects.new('ZoomCam', cd); sc.collection.objects.link(co); sc.camera = co
co.location = (0, -450, 40); co.rotation_euler = (math.radians(89), 0, 0)
bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
cd.lens = 35; cd.keyframe_insert('lens', frame=1)
cd.lens = 70; cd.keyframe_insert('lens', frame=25)
bpy.ops.wm.save_as_mainfile(filepath=out)
