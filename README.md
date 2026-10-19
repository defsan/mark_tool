# Mark Tool

A local, browser-based STL viewer for marking up 3D models and feeding the result back to an AI.

Point it at a folder of model projects, open an `.stl`, and annotate it with **pins**, **faces** or **arrows**, each with a comment. Copy an annotated snapshot (3D view + a legend with exact coordinates) to the clipboard and paste it into a chat, or use the built-in **AI chat** panel, which sends the snapshot, marks and the project's `.scad` files to Claude and reloads the model when the STL changes.

## Features

- **Library browser**: every folder under your models folder that contains `.stl` files becomes a project; models are listed newest first. ⌘K / Ctrl+K searches all folders and files.
- **Marks**
  - **Pin**: a single point (x, y, z).
  - **Face**: click a face to select the whole flat/coplanar region (adjustable tolerance); gives centroid, normal, area.
  - **Arrow**: click-drag to show a direction and distance ("pull this face out 5 mm").
- **Snapshot to clipboard**: the view with numbered markers plus a text legend of every mark.
- **View modes**: Solid / X-ray / Edges only (`V` cycles), axes toggle.
- **Slicer** (`S`): export a slab of the model along XY/XZ/YZ as a new STL (needs OpenSCAD).
- **AI chat**: talk to Claude about the model; it can edit the project's `.scad` files and re-export the STL. Backends: Claude Code CLI or the Anthropic API.

All coordinates are in the model's native space (the mesh is never recentered), so they match your source files directly.

## Requirements

- Python 3.9+ (standard library only for the viewer)
- A modern browser (three.js is loaded from jsDelivr)
- Optional: [OpenSCAD](https://openscad.org/) for the slicer and the AI export tools
- Optional, for the AI chat panel:
  - **Claude Code CLI** backend (default): `claude` on your PATH and logged in, or
  - **Anthropic API** backend: `python3 -m venv .venv && .venv/bin/pip install anthropic`, plus an API key

## Getting started

```sh
git clone https://github.com/defsan/mark_tool.git
cd mark_tool
./mark-tool --set-root ~/path/to/3d-models   # your models folder (optional, see below)
./mark-tool                                   # start the server and open http://127.0.0.1:8743/
```

## Choosing the models folder

The **library folder** (work folder) is the folder that holds your model projects, e.g.

```
3d-models/
  bracket/        bracket.scad, bracket.stl
  enclosure/      lid.stl, base.stl
    v2/           lid.stl          ← listed as its own project "enclosure/v2"
```

Set it either way; it is saved in `config.json` and remembered across restarts:

- **In the browser**: click **Change…** next to the library path at the top of the sidebar, then type a path or click **Browse…** (native folder picker on macOS) and **Set**. Projects reload immediately.
- **From the command line**: `./mark-tool --set-root /path/to/models`

If none is set, the folder you first ran `mark-tool` from is used.

## Command line

```sh
./mark-tool                   # start (or reuse) the server and open the browser
./mark-tool --set-root PATH   # set the library folder and restart
./mark-tool --status          # is it running, and which library folder
./mark-tool --stop            # stop the server
./mark-tool --no-open         # start without opening a browser tab
./mark-tool --port 9000       # use another port (default 8743)
```

## Privacy

The server listens on `127.0.0.1` only. Settings (including any API key you enter), chats and screenshots are stored locally in `mark-tool.db` and `chat-images/` next to the app. These files, along with `config.json` and `server.log`, are git-ignored.

## Claude Code skill

`skill/SKILL.md` teaches Claude Code how to launch and use the tool. Copy it to `~/.claude/skills/mark-tool/SKILL.md` and put `mark-tool` on your PATH (e.g. `ln -s "$PWD/mark-tool" /usr/local/bin/mark-tool`).
