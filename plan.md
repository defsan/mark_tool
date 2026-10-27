# Mark Tool — plan

Running list of features: done, next, and ideas. Newest decisions at the top of each section.

## Done

### Folder tree + new projects (2026-10-27)
- Sidebar **Folders** tree replaces the Project dropdown (`GET /api/tree`). Root node = the library folder; every non-hidden folder is shown, including empty ones; `.stl` count on the right. Expanded state remembered per browser; arrow keys navigate.
- Right-click a folder → **New sub-folder…** → inline name box (`POST /api/folder/new`), then the new folder is selected.
- A folder without `.stl` files shows a **No model** screen. The chat targets the folder itself (model `""`, Claude runs with the folder as cwd), sends no screenshot, and is prompted to create `<part>.scad` + `<part>.stl`. When a new STL appears, the server moves that chat onto it and the viewer opens it.

### Viewport toolbar + View dropdown (2026-10-19)
- Toolbar strip across the top of the 3D viewport (`#toolbar` in `index.html`). Future viewport tools go here.
- **View** dropdown: Solid / X-ray / Edges only. `V` cycles modes. Choice is remembered per browser.
  - **X-ray** — mesh at ~22% opacity, double-sided, no depth writes, so every wall layer and all feature edges show through equally.
  - **Edges only** — faces hidden but still written to depth; visible feature edges bright, hidden edges dim blue. Good for comparing recess depth against outer walls.
  - **Edge angle** (shown in X-ray/Edges) — only creases sharper than this are drawn (default 20°). Lower it to show softer edges, raise it to hide tessellation on curves.
- Picking (pins, faces, arrows) still raycasts the mesh in every mode. Snapshots capture the current view.

### Axes toggle + cleaner snapshots (2026-10-19)
- Toolbar icon button shows/hides the origin axes (lines + X/Y/Z letters) and the axis legend. Remembered per browser.
- Snapshots never include the X/Y/Z letters (noise for the AI); axis lines stay if axes are shown.

### Slicer (2026-10-19)
- Toolbar **✂ Slicer** button (or `S`) opens a panel: plane XY / XZ / YZ, thickness (mm), position (mm).
- A large translucent slab follows the mouse — over the model it snaps to the point under the cursor, off the model it tracks the nearest point along the axis. The model's surface inside the slab is highlighted orange (clipping planes on a copy of the mesh).
- Click (or **Save slice as STL** / Enter in the position box) → `POST /api/slice` → OpenSCAD (Manifold) intersects the model with the slab (centered on the plane) and saves `<model>-slice-<PLANE>-<AXIS><pos>-t<thickness>.stl` next to the model. Never overwrites (adds `-2`, `-3`…). **Open** loads the slice with the same camera.
- Arrow keys nudge 0.1 mm (Shift: 1 mm); Esc closes. Marks can't be placed while the slicer is open.

## Next

### Isolate surfaces
Show only chosen surfaces so a pocket floor can be compared with a wall without clutter.
- Toolbar toggle "Isolate". Click a face → selects its coplanar region (reuse the face-mode flood fill: `faceData`, coplanar tolerance).
- Shift-click adds more regions; Esc / "Show all" clears.
- Everything not selected is either hidden or ghosted (x-ray-style) — let the user pick which.
- Possibly "isolate parallel faces": pick one face, show every face with the same normal, so all levels of a stepped surface appear at once.

### Measure
Get exact numbers instead of judging depth by eye.
- Toolbar toggle "Measure".
- Point → point: distance plus ΔX/ΔY/ΔZ.
- Face → face: when both are planar and (near-)parallel, show the perpendicular distance between the planes (this is the indentation-depth case). Otherwise show the angle between them.
- Snap to vertices/edges when close.
- Measurements show as a line + label in the viewport, appear in snapshots, and can be saved as a mark type so they go to the AI chat with the other notes.

## Ideas (unscheduled)
- **Section plane (view-only)** — the slicer already places a plane; add a "hide everything on one side" toggle with a filled cut face, for inspecting a profile without exporting.
- Slicer: angled/arbitrary planes (click a face → slice parallel to it); batch "slice every N mm" export.
- Turn on hidden edges in Solid mode too (dim hidden lines over the shaded model).
- Standard view buttons in the toolbar (Front / Top / Right / Iso) and orthographic camera toggle — makes depth comparisons undistorted.
- Edge colour / thickness options; dashed hidden lines.
