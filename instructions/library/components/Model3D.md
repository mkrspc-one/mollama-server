COMPONENT: Model3D

A 3D viewer, as wide as the reply. The shape is centred and the camera is set back far enough to see all of it, so its real size and units do not matter. It comes from a file, or you write it yourself as text.

Written as `<Model3D src="https://..." />` for a file, or as `<Model3D format="obj"> ... </Model3D>` with the text of an OBJ or ASCII STL file between the tags.

| Attribute | Values | What it does on screen |
|---|---|---|
| src | the https address of a 3D model file | The file shown. Its type is read from the end of the address: glb, gltf, obj, stl, fbx, ply, dae, 3mf, 3ds. |
| format | obj, stl | For your own text: which of the two it is written in. For a file: its type, when the address does not end in it. |
| fileName | a file name such as pyramid.obj | For your own text: the name shown with it, and the name it is saved under. |
| autoRotate | no value | The shape turns slowly by itself until the user stops it. |
| height | a CSS length with its unit, such as 100% or 240px | How tall the viewer is. Default 360px. |

A glb or gltf file keeps its own colours and materials. An obj, stl or ply file is drawn in one plain colour. In obj, stl, ply, 3mf and 3ds files the Z axis is up.

The user can drag to turn the shape, scroll to zoom, click the small cube at the top right to look from a face or corner, and open the tools button at the bottom right for zoom, reset, auto-rotate, wireframe, grid, shadows, full screen and fixed views (front, back, left, right, top, bottom). A shape you wrote yourself also gets Download and "Save to my files".

**Your own shape as OBJ.** One statement on each line. Z is up.
- `v x y z` is a corner. Use all three so the shape has depth. Three more numbers from 0 to 1 give that corner a colour: `v 0 0 0 1 0 0` is red.
- `f 1 2 3` is a face joining corners, counted from 1 in the order they were written. A face may have more than three corners.
- Other lines are ignored. Text with no faces shows an empty viewer.

**Your own shape as ASCII STL.** The text starts with `solid name` and ends with `endsolid name`; each triangle is `facet normal nx ny nz`, `outer loop`, three `vertex x y z` lines, `endloop`, `endfacet`.

The file is fetched for the user by Mollama: it must be a public https address, at most 50 MB. While it loads the user sees "Loading the file from the web…". If it cannot be shown they see a short reason instead, such as "Nothing exists at this address…", "This address is a web page, not a file…" or "This file is larger than 50 MB…". A "Source:" link to the address is shown underneath. A file that cannot be read shows "Failed to load 3D model" with a Retry button.

```component
<Model3D format="obj" fileName="pyramid.obj" autoRotate>
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0.5 0.5 1
f 1 2 3 4
f 1 2 5
f 2 3 5
f 3 4 5
f 4 1 5
</Model3D>
```
A square-based pyramid standing on its base, turning slowly.
