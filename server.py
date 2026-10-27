#!/usr/bin/env python3
"""Local server for the 3D mark tool.

Serves the viewer app plus .stl files found under a configured library root
(config.json next to this file). The root contains "project" folders
(immediate subdirectories); each project's .stl files are found recursively.
"""
import http.server
import json
import os
import resource
import shutil
import socketserver
import subprocess
import tempfile
import threading
import urllib.parse
import webbrowser
from pathlib import Path

import ai

APP_DIR = Path(__file__).resolve().parent
CONFIG_FILE = APP_DIR / "config.json"
DEFAULT_PORT = 8743


def load_root():
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text())
            root = cfg.get("root")
            if root:
                return Path(root).expanduser().resolve()
        except Exception:
            pass
    return Path(os.environ.get("MARK_TOOL_ROOT", Path.cwd())).expanduser().resolve()


ROOT = load_root()


def set_root(path):
    """Point the library at another folder, persisted in config.json."""
    global ROOT
    root = Path(path or "").expanduser().resolve()
    if not path or not root.is_dir():
        raise ValueError(f"Not a folder: {path}")
    cfg = {}
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text())
        except Exception:
            pass
    cfg["root"] = str(root)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))
    ROOT = root
    return root


def browse_folder():
    """Native folder picker (macOS only). Returns the chosen path, or None."""
    if not shutil.which("osascript"):
        raise RuntimeError("Folder picker is only available on macOS; type the path instead")
    script = (
        f'POSIX path of (choose folder with prompt "Choose the models library folder" '
        f'default location (POSIX file {json.dumps(str(ROOT))}))'
    )
    proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        return None  # cancelled
    return proc.stdout.strip().rstrip("/") or "/"
PORT = int(os.environ.get("MARK_TOOL_PORT", DEFAULT_PORT))


def find_stl_dirs(base: Path):
    """Every directory at or under base (itself included) that has .stl files
    directly inside it — each becomes its own selectable project, so a
    subfolder's models never get mixed into its parent's model list."""
    dirs = []
    if any(base.glob("*.stl")):
        dirs.append(base)
    for child in sorted(base.iterdir(), key=lambda p: p.name.lower()):
        if child.is_dir() and not child.name.startswith("."):
            dirs.extend(find_stl_dirs(child))
    return dirs


def list_projects():
    if not ROOT.is_dir():
        return []
    projects = []
    for d in find_stl_dirs(ROOT):
        if d == ROOT:
            name, label = ".", "(root files)"
        else:
            name = str(d.relative_to(ROOT))
            label = name
        count = len(list(d.glob("*.stl")))
        projects.append({"name": name, "label": label, "count": count})
    return projects


def list_index():
    """Every project with its .stl files, for the ⌘K search palette."""
    if not ROOT.is_dir():
        return []
    out = []
    for d in find_stl_dirs(ROOT):
        name = "." if d == ROOT else str(d.relative_to(ROOT))
        files = sorted((p.name for p in d.glob("*.stl")), key=str.lower)
        out.append({"name": name, "label": "(root files)" if name == "." else name, "files": files})
    return out


def folder_tree():
    """Every (non-hidden) folder under the library root as a nested tree, for
    the sidebar. Empty folders are included so new projects can be started."""
    if not ROOT.is_dir():
        return None

    def node(d):
        try:
            subdirs = sorted((c for c in d.iterdir() if c.is_dir() and not c.name.startswith(".")),
                             key=lambda c: c.name.lower())
        except OSError:
            subdirs = []
        return {
            "name": "." if d == ROOT else str(d.relative_to(ROOT)),
            "label": d.name or str(d),
            "count": len(list(d.glob("*.stl"))),
            "children": [node(c) for c in subdirs],
        }

    return node(ROOT)


def create_folder(parent, name):
    """Make a new sub-folder of a library folder; returns its project name."""
    base = resolve_project_dir(parent)
    if base is None:
        raise ValueError("Parent folder not found")
    name = (name or "").strip()
    if not name or name in (".", "..") or name.startswith(".") or "/" in name or "\\" in name:
        raise ValueError(f"Invalid folder name: {name!r}")
    folder = base / name
    if folder.exists():
        raise ValueError(f"{name} already exists")
    folder.mkdir()
    return str(folder.relative_to(ROOT))


def resolve_project_dir(name):
    if name == ".":
        return ROOT
    if not name:
        return None
    rel = Path(name)
    if rel.is_absolute() or ".." in rel.parts:
        return None
    candidate = (ROOT / rel).resolve()
    try:
        candidate.relative_to(ROOT)
    except ValueError:
        return None
    if not candidate.is_dir():
        return None
    return candidate


def resolve_model_path(project, relpath):
    """Absolute path of an .stl inside a project, or None if invalid/missing."""
    base = resolve_project_dir(project)
    if base is None:
        return None
    rel = Path(relpath or "")
    if not relpath or rel.is_absolute() or ".." in rel.parts:
        return None
    candidate = (base / rel).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    if not candidate.is_file() or candidate.suffix.lower() != ".stl":
        return None
    return candidate


SLICE_AXES = {"x": ("YZ", 0), "y": ("XZ", 1), "z": ("XY", 2)}
SLICE_EXTENT = 100000  # mm; slab size along the two in-plane axes ("infinite")


def slice_model(project, relpath, axis, pos, thickness):
    """Intersect the model with a slab perpendicular to `axis`, centred on
    `pos`, `thickness` mm thick. Writes a new STL next to the source model
    and returns its name. Uses the OpenSCAD CLI (Manifold backend)."""
    src = resolve_model_path(project, relpath)
    if src is None:
        raise ValueError("Model not found")
    if axis not in SLICE_AXES:
        raise ValueError("axis must be x, y or z")
    pos, thickness = float(pos), float(thickness)
    if not 0 < thickness <= 10000:
        raise ValueError("thickness must be > 0 mm")
    openscad = shutil.which("openscad") or "/opt/homebrew/bin/openscad"
    if not Path(openscad).exists():
        raise RuntimeError("OpenSCAD CLI not found (brew install openscad)")

    plane, idx = SLICE_AXES[axis]
    size = [SLICE_EXTENT] * 3
    size[idx] = thickness
    origin = [-SLICE_EXTENT / 2] * 3
    origin[idx] = pos - thickness / 2

    def num(v):
        return f"{v:g}"

    out_dir = src.parent
    base_name = f"{src.stem}-slice-{plane}-{axis.upper()}{num(round(pos, 2))}-t{num(thickness)}"
    out = out_dir / f"{base_name}.stl"
    n = 2
    while out.exists():
        out = out_dir / f"{base_name}-{n}.stl"
        n += 1

    scad = (
        "intersection() {\n"
        f"  import({json.dumps(str(src))});\n"
        f"  translate([{', '.join(map(num, origin))}]) cube([{', '.join(map(num, size))}]);\n"
        "}\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        scad_file = Path(tmp) / "slice.scad"
        tmp_out = Path(tmp) / "slice.stl"
        scad_file.write_text(scad)
        proc = subprocess.run(
            [openscad, "--backend", "Manifold", "--export-format", "binstl", "-o", str(tmp_out), str(scad_file)],
            capture_output=True, text=True, timeout=180,
        )
        log = (proc.stderr or "") + (proc.stdout or "")
        if "top level object is empty" in log.lower() or (proc.returncode == 0 and not tmp_out.exists()):
            raise ValueError("Slice is empty: the slab doesn't cross the model there")
        if proc.returncode != 0 or not tmp_out.exists():
            tail = "\n".join(log.strip().splitlines()[-5:])
            raise RuntimeError(f"OpenSCAD failed: {tail}")
        shutil.move(str(tmp_out), out)
    return str(out.relative_to(resolve_project_dir(project)))


def list_models(project):
    base = resolve_project_dir(project)
    if base is None:
        return None
    # Newest first, so the model just exported is at the top of the dropdown.
    files = sorted(((p, p.stat().st_mtime) for p in base.glob("*.stl")),
                   key=lambda f: (-f[1], f[0].name.lower()))
    return [{"path": p.name, "mtime": mtime} for p, mtime in files]


def status_checks():
    """Self-test for /status (polled by the Service Manager). Each check is {ok, detail}."""
    def check(fn):
        try:
            return fn()
        except Exception as e:
            return {"ok": False, "detail": f"{type(e).__name__}: {e}"}

    def database():
        with ai.db() as conn:
            conn.execute("SELECT 1").fetchone()
        return {"ok": True, "detail": "readable"}

    def library():
        if not ROOT.is_dir():
            return {"ok": False, "detail": f"{ROOT} is not a directory"}
        os.listdir(ROOT)
        return {"ok": True, "detail": str(ROOT)}

    def app_files():
        with open(APP_DIR / "index.html", "rb") as f:
            f.read(1)
        return {"ok": True, "detail": "index.html readable"}

    def file_descriptors():
        used = len(os.listdir("/dev/fd"))
        limit = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
        return {"ok": used < limit * 0.8, "detail": f"{used} of {limit} open"}

    checks = {
        "database": check(database),
        "library": check(library),
        "app_files": check(app_files),
        "file_descriptors": check(file_descriptors),
    }
    return {"ok": all(c["ok"] for c in checks.values()), "checks": checks}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/status":
            status = status_checks()
            self.send_json(status, status=200 if status["ok"] else 503)
            return
        if parsed.path == "/api/root":
            self.send_json({"root": str(ROOT)})
            return
        if parsed.path == "/api/projects":
            self.send_json(list_projects())
            return
        if parsed.path == "/api/tree":
            self.send_json({"root": str(ROOT), "tree": folder_tree()})
            return
        if parsed.path == "/api/index":
            self.send_json(list_index())
            return
        if parsed.path == "/api/models":
            qs = urllib.parse.parse_qs(parsed.query)
            project = qs.get("project", ["."])[0]
            models = list_models(project)
            if models is None:
                self.send_error(404, "Project not found")
                return
            self.send_json(models)
            return
        if parsed.path == "/api/model":
            # Project/path as query params: a "." (root) project can't ride in
            # the URL path, since browsers collapse "/./" segments.
            qs = urllib.parse.parse_qs(parsed.query)
            self.serve_model(qs.get("project", ["."])[0], qs.get("path", [""])[0])
            return
        if parsed.path.startswith("/models/"):
            self.serve_model_file(parsed.path[len("/models/"):])
            return
        qs = urllib.parse.parse_qs(parsed.query)
        q = lambda k, d=None: qs.get(k, [d])[0]
        if parsed.path == "/api/settings":
            self.send_json(ai.get_settings(mask=True))
            return
        if parsed.path == "/api/chats":
            self.send_json(ai.list_chats(q("project", "."), q("model", "")))
            return
        if parsed.path == "/api/chat":
            chat = ai.get_chat(int(q("id", "0")))
            if not chat:
                self.send_error(404, "Chat not found")
                return
            chat.pop("api_messages", None)
            self.send_json({"chat": chat, "messages": ai.get_messages(chat["id"])})
            return
        if parsed.path == "/api/job":
            job = ai.JOBS.get(q("id", ""))
            if not job:
                self.send_error(404, "Job not found")
                return
            self.send_json(job.snapshot(int(q("since", "0"))))
            return
        if parsed.path.startswith("/chat-images/"):
            name = Path(urllib.parse.unquote(parsed.path[len("/chat-images/"):])).name
            f = ai.IMAGES_DIR / name
            if not f.is_file():
                self.send_error(404, "Image not found")
                return
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self.send_error(400, "Invalid JSON body")
            return
        try:
            if parsed.path == "/api/settings":
                ai.save_settings(body)
                self.send_json(ai.get_settings(mask=True))
                return
            if parsed.path == "/api/root":
                try:
                    root = set_root(body.get("root"))
                except ValueError as e:
                    self.send_json({"ok": False, "error": str(e)}, status=400)
                    return
                self.send_json({"ok": True, "root": str(root)})
                return
            if parsed.path == "/api/folder/new":
                try:
                    name = create_folder(body.get("parent", "."), body.get("name"))
                except ValueError as e:
                    self.send_json({"ok": False, "error": str(e)}, status=400)
                    return
                self.send_json({"ok": True, "name": name})
                return
            if parsed.path == "/api/root/browse":
                self.send_json({"ok": True, "path": browse_folder()})
                return
            if parsed.path == "/api/settings/test":
                self.send_json({"ok": True, "message": ai.test_connection()})
                return
            if parsed.path == "/api/chat/new":
                self.send_json({"id": ai.create_chat(body["project"], body.get("model", ""))})
                return
            if parsed.path == "/api/chat/delete":
                ai.delete_chat(int(body["id"]))
                self.send_json({"ok": True})
                return
            if parsed.path == "/api/chat/send":
                project_dir = resolve_project_dir(body.get("project"))
                if project_dir is None:
                    self.send_error(400, "Unknown project")
                    return
                # No model = a folder-level chat, e.g. generating a new model in an empty folder.
                body["model"] = body.get("model") or ""
                job, chat_id = ai.start_job(ROOT, project_dir, body)
                self.send_json({"job_id": job.id, "chat_id": chat_id})
                return
            if parsed.path == "/api/slice":
                try:
                    name = slice_model(body.get("project"), body.get("model"), body.get("axis"),
                                       body.get("pos"), body.get("thickness"))
                except ValueError as e:
                    self.send_json({"ok": False, "error": str(e)}, status=400)
                    return
                self.send_json({"ok": True, "path": name})
                return
            if parsed.path == "/api/job/cancel":
                self.send_json({"ok": ai.cancel_job(body.get("id", ""))})
                return
        except Exception as e:  # noqa: BLE001
            self.send_json({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=500)
            return
        self.send_error(404, "Not found")

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def serve_model_file(self, raw):
        raw = urllib.parse.unquote(raw)
        parts = raw.split("/", 1)
        if len(parts) != 2:
            self.send_error(400, "Invalid model path")
            return
        self.serve_model(*parts)

    def serve_model(self, project, relpath):
        candidate = resolve_model_path(project, relpath)
        if candidate is None:
            self.send_error(404, "Model not found")
            return
        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "model/stl")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    ai.init_db()
    url = f"http://127.0.0.1:{PORT}/"
    with ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"3D mark tool running at {url}")
        print(f"Library root: {ROOT}")
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
