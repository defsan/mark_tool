# Mark Tool

A local, browser-based STL viewer for marking up 3D models and feeding the result back to an AI.

Browse a library of project folders, open an `.stl`, and annotate it with **pins** (points), **faces** (whole coplanar regions) or **arrows** (directional pulls/pushes), each with a comment. Copy an annotated snapshot (view + legend with exact coordinates) to the clipboard, or use the built-in **AI chat** panel, which sends the snapshot, marks and project `.scad` files to Claude and reloads the model when the STL changes.

Other tools: View modes (Solid / X-ray / Edges only), axes toggle, ⌘K search palette, and a **Slicer** that exports a slab of the model as a new STL via OpenSCAD.

## Requirements

- Python 3.9+ (standard library only for the viewer)
- A modern browser (three.js is loaded from jsDelivr)
- Optional: [OpenSCAD](https://openscad.org/) for the slicer and AI export tools
- Optional, for the AI chat panel:
  - **Claude Code CLI** backend (default): `claude` on your PATH and logged in, or
  - **Anthropic API** backend: `python3 -m venv .venv && .venv/bin/pip install anthropic`, plus an API key

## Usage

```sh
./mark-tool --set-root ~/path/to/3d-models   # one-time: folder containing your project folders
./mark-tool                                   # start (or reuse) the server and open http://127.0.0.1:8743/
./mark-tool --status | --stop | --no-open
```

The server binds to `127.0.0.1` only. Settings (including any API key you enter), chats and screenshots are stored locally in `mark-tool.db` and `chat-images/` next to the app, which are git-ignored.

## Claude Code skill

`skill/SKILL.md` teaches Claude Code how to launch and use the tool. Copy it to `~/.claude/skills/mark-tool/SKILL.md` and put `mark-tool` on your PATH.
