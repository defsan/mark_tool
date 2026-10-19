---
name: mark-tool
description: Launch the 3D Mark Tool — a local browser-based STL viewer where the user browses their 3D-model project library and marks up a model with pins (points), faces (whole flat/coplanar regions), or arrows (directional pulls/pushes), each with a comment, then copies an annotated snapshot to the clipboard to paste back into chat. Use when the user wants to visually mark up a 3D/CAD model, review STL geometry side by side with edits, or asks to "open the mark tool," "review the model," or "mark up the STL."
---

# 3D Mark Tool

A standalone local web app (installed wherever you cloned this repo, launched via the
`mark-tool` CLI on PATH) for visually annotating STL files. It is project-agnostic: it
serves a configured **library root** directory containing multiple project folders, and
lets the user pick a project, then a model within it, from dropdowns in the browser.

## Launching it

Run:

    mark-tool

This starts the server if it isn't already running (reusing it otherwise) and opens
`http://127.0.0.1:8743/` in the browser. It runs detached from your shell, so the Bash
call returns immediately — no need to background it yourself.

If the user hasn't configured a library root yet, `mark-tool` defaults to the current
working directory on first run. To point it at the right place (the folder that
contains their various project subfolders, e.g. `~/3dmodels`), run:

    mark-tool --set-root "/path/to/their/models/library"

The user can also change it in the browser: **Change…** next to the library path at the
top of the sidebar (type a path or **Browse…** for the macOS folder picker, then **Set**).
This is a one-time setup per machine — it's remembered in
`config.json` next to the app and used by every future session. Only re-run
`--set-root` if the user explicitly wants to change it.

Other subcommands:

    mark-tool --status      # is it running, and what's the configured root
    mark-tool --stop        # stop the background server
    mark-tool --no-open     # start/reuse without opening a browser tab

## Mark types

The sidebar has a "Mark type" selector with three modes:

- **Pin** — click a point on the model. A single (x, y, z) location plus a comment.
  Use for a localized tweak ("make this boss taller").
- **Face** — click a face. Flood-fills all triangles connected to the clicked one whose
  normal stays within the "Coplanar tolerance" (° input, default 3°) of the *clicked*
  face's normal, and highlights the whole resulting flat/near-flat patch. Gives centroid,
  average normal, approximate area, and triangle count, plus a comment. Use to mark an
  entire flat surface, panel, or region rather than one point ("chamfer this whole face",
  "this panel should be recessed"). If the highlighted patch is too small or too big for
  what the user means, they can raise/lower the tolerance number and click again — a
  finely faceted curved surface (e.g. a coarse-$fn cylinder) needs a very small tolerance
  (~1° or less) to avoid the patch creeping around the curve.
- **Arrow** — click-drag on the model. Start point/normal come from where the drag began;
  the end point follows the surface while the drag stays over the mesh, or slides into
  empty space (on a plane through the start point, facing the camera) once the drag
  leaves the model — so the user can point an arrow *away* from a face to mean "extrude/
  pull the surface out this far, this direction." Gives start, end, length, and unit
  direction, plus a comment. Use for directional/magnitude edits ("pull this face out
  5mm this way", "taper this edge toward here").

All three share one numbered sequence and one color cycle, and can be freely mixed on
the same model.

## Workflow

1. Launch it (`mark-tool`) and tell the user which project/model is selected, or ask
   them to pick the right one from the dropdowns if there are several candidates.
2. After you edit a `.scad`/CAD source and re-export the `.stl`, tell the user to click
   **"Reload projects & model"** in the tool to refresh the geometry in place — it keeps
   their camera angle and existing marks so they can compare before/after (face
   highlights and arrows are static overlays at fixed world coordinates, so they stay put
   even if the underlying mesh topology changes on reload).
3. The user clicks **"Copy snapshot to clipboard"** and pastes the image into the chat.
   The pasted image contains the 3D view with numbered markers *and* a legend below it
   listing, per mark: for a pin, its (x, y, z); for a face, centroid, normal, area, and
   triangle count; for an arrow, start/end points, length, and unit direction — plus each
   mark's comment text. Read the legend text directly rather than estimating from pixel
   positions or the rendered highlight's apparent size.
4. Map each mark to the relevant module/variable in the project's source file:
   - Pin → the enclosing `.scad` module whose geometry contains that point.
   - Face → the module/face whose surface contains the centroid and matches the given
     normal — a flat face mark usually corresponds to one side of a `cube`/`cylinder` cap/
     `linear_extrude` profile edge in the source, and the area/triangle count can help
     confirm which one.
   - Arrow → apply the given direction vector and length as the magnitude/direction of
     the requested change (e.g. move a face along its normal by the arrow's length, or
     add material in the arrow's direction) at the module containing the start point.
5. Re-export the `.stl` after editing.

## Search palette

⌘K / Ctrl+K (or the "Search folders & files" button) opens a palette over every
project folder and `.stl` (`/api/index`, `search.js`). Space-separated tokens must all
match (substring, case-insensitive) the name or folder path; Tab cycles All/Folders/
Files. Picking a folder switches Project (loading its first model); picking a file
switches Project and Model.

## AI chat panel (built-in modeling assistant)

The left side of the tool has an **AI chat** tab (collapsible). Each message the user
sends automatically includes a screenshot of the current view + marks legend, the marks
as text (exact coordinates), the camera, the absolute `.stl` path, and the project's
`.scad` files. When the AI run finishes, the server diffs `.stl` mtimes in the project
folder and the viewer reloads the model in place (camera + marks kept) if it changed.

- Code: `server.py` (HTTP), `ai.py` (SQLite + backends + jobs), `chat.js` (panel UI).
  `app.js` exposes `window.markTool` (snapshot, notes, camera, reload) for `chat.js`.
- Storage: `mark-tool.db` next to the app (SQLite: `settings`, `chats`,
  `messages`); sent screenshots in `chat-images/`. Configure via the ⚙ button.
- Backends:
  - **Claude Code CLI** (default): runs `claude -p … --output-format stream-json` with the
    project folder as cwd, `--resume`s the chat's session, allowed tools/permission mode
    from settings. Child env (`claude_code_env` in `ai.py`): drops `CLAUDE_CODE_*`
    session vars; auth = settings OAuth token, else an `sk-ant-oat…` token found in
    `ANTHROPIC_API_KEY` moved to
    `CLAUDE_CODE_OAUTH_TOKEN`, else the stored `claude` login. "Test connection" runs
    a real `claude -p` call.
  - **Anthropic API**: Anthropic SDK (in the tool's `.venv`), model/effort/max tokens/key
    from settings; tools `list_files`, `read_file`, `write_file`, `edit_file`,
    `openscad_export` (renders to a temp file, then swaps in), `openscad_preview`, all
    confined to the project folder. Full message history is stored per chat.
- The launcher runs the server with `.venv/bin/python` when that venv exists.

## Notes

- All coordinates (pins, face centroids/normals, arrow start/end) are in the model's
  native coordinate space (the viewer never recenters the mesh), so they compare
  directly against dimensions/offsets in the source file.
- "Projects" are every directory under the configured library root (the root itself
  included) that has `.stl` files directly inside it — a folder with both its own
  `.stl` files and a subfolder of `.stl` files shows up as two separate project entries
  (e.g. `tram` and `tram/New Folder With Items`), each listing only its own direct
  files, never a subfolder's.
