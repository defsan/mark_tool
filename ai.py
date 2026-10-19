"""AI chat backend for the 3D mark tool.

Persists settings, chats and messages in SQLite (mark-tool.db next to this
file) and runs each user turn as a background job against one of two
backends:

- "claude_code": the local `claude` CLI in headless mode (`claude -p`),
  run with the project folder as its working directory, so it has the same
  tools (file edits, openscad, MCP servers) as an interactive session.
  Conversation continuity uses `--resume <session_id>`.
- "anthropic": the Claude API via the Anthropic SDK, with a small set of
  file/openscad tools confined to the project folder.

The browser polls /api/job for progress events; when a job ends the server
reports which .stl files in the project changed so the viewer can reload.
"""
import base64
import contextlib
import json
import os
import shlex
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
DB_FILE = APP_DIR / "mark-tool.db"
IMAGES_DIR = APP_DIR / "chat-images"

DEFAULT_SETTINGS = {
    "backend": "claude_code",              # claude_code | anthropic
    "cc_path": "claude",
    "cc_model": "",                        # empty = Claude Code's default
    "cc_permission_mode": "acceptEdits",
    "cc_allowed_tools": "Read Edit Write Glob Grep Bash(openscad:*) mcp__openscad",
    "cc_inherit_api_key": "0",             # 1 = pass ANTHROPIC_API_KEY through
    "cc_oauth_token": "",                  # optional `claude setup-token` token
    "api_key": "",                         # empty = SDK default credential chain
    "api_model": "claude-opus-5-5",
    "api_effort": "high",
    "api_max_tokens": "32000",
    "api_fallbacks": "1",
    "openscad_path": "",                   # empty = autodetect
    "system_extra": "",
    "auto_reload": "1",
    "clear_marks_on_success": "0",
}
SECRET_KEYS = {"api_key", "cc_oauth_token"}

# Models that accept the server-side refusal fallback ("default" form).
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}

BASE_INSTRUCTIONS = """\
You are the AI modeling assistant built into the user's 3D Mark Tool, a browser
STL viewer. The user is looking at one model and talks to you from a chat panel
next to it. Each message may include a screenshot of their current view plus a
legend of marks they placed on the model:
- Pin: a point (x, y, z).
- Face: a flat region — centroid, normal, approximate area, triangle count.
- Arrow: a directional change — start, end, length, unit direction.
All coordinates are in the model's native space in mm (never recentered), so
they compare directly to dimensions/offsets in the source file. Read the legend
text for exact numbers rather than estimating from the picture.

How to work:
- The editable source is normally an OpenSCAD .scad file next to the .stl
  (usually the same base name). Edit the source, never hand-edit the STL.
- Follow OpenSCAD conventions: mm, Z up, named top-level variables for key
  dimensions, 0.01 mm overlaps on coplanar booleans.
- After editing, re-export the STL to the exact path the viewer is showing
  (e.g. `openscad -o "<model.stl>" "<source.scad>"`). The viewer reloads that
  file automatically when you finish, so the export is what the user sees.
- If the model has no .scad source, say so and propose how to proceed instead
  of guessing.
- Finish with a short summary of what you changed (variables/modules and new
  values). Keep it brief — the user sees the result in 3D.
"""

_db_lock = threading.Lock()


# --- Storage ------------------------------------------------------------

@contextlib.contextmanager
def db():
    # sqlite3's own context manager only commits/rolls back; it never closes the connection.
    # Leaked connections used up the process's 256 file descriptors (Oct 2026), after which
    # neither the database nor the app's own files could be opened.
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db():
    IMAGES_DIR.mkdir(exist_ok=True)
    with _db_lock, db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project TEXT NOT NULL,
                model TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                backend TEXT NOT NULL DEFAULT '',
                session_id TEXT,              -- claude_code: CLI session to resume
                api_messages TEXT,            -- anthropic: full message history (JSON)
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                role TEXT NOT NULL,           -- user | assistant | activity | error
                content TEXT NOT NULL,
                image TEXT,                   -- filename under chat-images/
                meta TEXT,                    -- JSON (changed files, cost, ...)
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chats_model ON chats(project, model, updated_at);
            CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
            """
        )


def get_settings(mask=False):
    with db() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    out = dict(DEFAULT_SETTINGS)
    out.update({r["key"]: r["value"] for r in rows})
    if mask:
        for k in SECRET_KEYS:
            v = out.get(k) or ""
            out[k] = ("•" * 8 + v[-4:]) if v else ""
            out[f"{k}_set"] = bool(v)
    return out


def save_settings(values):
    with _db_lock, db() as conn:
        for k, v in values.items():
            if k not in DEFAULT_SETTINGS:
                continue
            # A masked secret coming back unchanged from the form means "keep".
            if k in SECRET_KEYS and isinstance(v, str) and v.startswith("•"):
                continue
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, str(v)),
            )


def list_chats(project, model):
    with db() as conn:
        rows = conn.execute(
            "SELECT id, title, backend, created_at, updated_at FROM chats "
            "WHERE project = ? AND model = ? ORDER BY updated_at DESC",
            (project, model),
        ).fetchall()
    return [dict(r) for r in rows]


def create_chat(project, model):
    now = time.time()
    with _db_lock, db() as conn:
        cur = conn.execute(
            "INSERT INTO chats(project, model, created_at, updated_at) VALUES(?, ?, ?, ?)",
            (project, model, now, now),
        )
        return cur.lastrowid


def get_chat(chat_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
    return dict(row) if row else None


def update_chat(chat_id, **fields):
    fields["updated_at"] = time.time()
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _db_lock, db() as conn:
        conn.execute(f"UPDATE chats SET {cols} WHERE id = ?", (*fields.values(), chat_id))


def delete_chat(chat_id):
    with _db_lock, db() as conn:
        imgs = conn.execute("SELECT image FROM messages WHERE chat_id = ? AND image IS NOT NULL", (chat_id,)).fetchall()
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    for r in imgs:
        (IMAGES_DIR / r["image"]).unlink(missing_ok=True)


def add_message(chat_id, role, content, image=None, meta=None):
    with _db_lock, db() as conn:
        cur = conn.execute(
            "INSERT INTO messages(chat_id, role, content, image, meta, created_at) VALUES(?, ?, ?, ?, ?, ?)",
            (chat_id, role, content, image, json.dumps(meta) if meta else None, time.time()),
        )
        return cur.lastrowid


def get_messages(chat_id):
    with db() as conn:
        rows = conn.execute(
            "SELECT id, role, content, image, meta, created_at FROM messages WHERE chat_id = ? ORDER BY id",
            (chat_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["meta"] = json.loads(d["meta"]) if d["meta"] else None
        out.append(d)
    return out


# --- Helpers ------------------------------------------------------------

def find_openscad(settings):
    if settings.get("openscad_path"):
        return settings["openscad_path"]
    for c in (shutil.which("openscad"), "/opt/homebrew/bin/openscad",
              "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"):
        if c and Path(c).exists():
            return c
    return "openscad"


def stl_mtimes(project_dir: Path):
    return {p.name: p.stat().st_mtime for p in project_dir.glob("*.stl")}


def build_prompt(text, ctx, image_path):
    """The per-turn context block sent with every user message."""
    lines = ["## Viewer context"]
    lines.append(f"- Model shown in viewer: {ctx['stl_path']}")
    lines.append(f"- Project folder: {ctx['project_dir']}")
    if ctx["scad_files"]:
        lines.append("- OpenSCAD sources in project folder: " + ", ".join(ctx["scad_files"]))
        if ctx.get("likely_source"):
            lines.append(f"- Likely source for this model: {ctx['likely_source']}")
    else:
        lines.append("- No .scad files in the project folder.")
    if ctx.get("camera"):
        c = ctx["camera"]
        lines.append(f"- Camera position {c.get('position')} looking at {c.get('target')}")
    if image_path:
        lines.append(f"- Screenshot of the current view + marks legend: {image_path}")
    marks = (ctx.get("marks_text") or "").strip()
    if marks:
        lines.append("\n## Marks on the model\n" + marks)
    lines.append("\n## Request\n" + (text.strip() or "(no text — act on the marks above)"))
    return "\n".join(lines)


# --- Jobs ---------------------------------------------------------------

class Job:
    def __init__(self, chat_id):
        self.id = uuid.uuid4().hex[:12]
        self.chat_id = chat_id
        self.events = []         # [{type, text, ...}]
        self.status = "running"  # running | done | error | cancelled
        self.result = None       # final payload: changed files etc.
        self.proc = None
        self.cancelled = False
        self.lock = threading.Lock()

    def emit(self, type_, text, persist=True, **extra):
        ev = {"type": type_, "text": text, **extra}
        with self.lock:
            self.events.append(ev)
        if persist and type_ in ("assistant", "activity", "error"):
            add_message(self.chat_id, type_, text, meta=extra or None)

    def snapshot(self, since):
        with self.lock:
            return {
                "status": self.status,
                "events": self.events[since:],
                "next": len(self.events),
                "result": self.result,
            }


JOBS = {}


def start_job(root: Path, project_dir: Path, payload):
    """payload: {chat_id?, project, model, text, image_b64?, marks_text, camera}"""
    settings = get_settings()
    project, model = payload["project"], payload["model"]
    chat_id = payload.get("chat_id")
    chat = get_chat(chat_id) if chat_id else None
    if not chat or chat["project"] != project or chat["model"] != model:
        chat_id = create_chat(project, model)
        chat = get_chat(chat_id)
    if chat["backend"] and chat["backend"] != settings["backend"]:
        # The conversation state belongs to the other backend; start fresh
        # rather than mixing histories.
        chat_id = create_chat(project, model)
        chat = get_chat(chat_id)

    image_name = None
    if payload.get("image_b64"):
        data = payload["image_b64"].split(",", 1)[-1]
        image_name = f"{chat_id}-{int(time.time() * 1000)}.png"
        (IMAGES_DIR / image_name).write_bytes(base64.b64decode(data))

    stl_path = project_dir / model
    scad_files = sorted(p.name for p in project_dir.glob("*.scad"))
    same_stem = project_dir / (Path(model).stem + ".scad")
    ctx = {
        "stl_path": str(stl_path),
        "project_dir": str(project_dir),
        "scad_files": scad_files,
        "likely_source": str(same_stem) if same_stem.exists() else (
            str(project_dir / scad_files[0]) if len(scad_files) == 1 else None),
        "marks_text": payload.get("marks_text"),
        "camera": payload.get("camera"),
    }
    text = payload.get("text") or ""
    add_message(chat_id, "user", text, image=image_name,
                meta={"marks_text": payload.get("marks_text")} if payload.get("marks_text") else None)
    if not chat["title"]:
        update_chat(chat_id, title=(text.strip() or "Marked edit")[:80], backend=settings["backend"])
    else:
        update_chat(chat_id, backend=settings["backend"])

    job = Job(chat_id)
    JOBS[job.id] = job
    before = stl_mtimes(project_dir)

    def run():
        try:
            if settings["backend"] == "anthropic":
                run_anthropic(job, settings, chat_id, project_dir, text, ctx, image_name)
            else:
                run_claude_code(job, settings, chat_id, project_dir, text, ctx, image_name)
            if job.status == "running":
                job.status = "cancelled" if job.cancelled else "done"
        except Exception as e:  # noqa: BLE001 — surface any failure to the UI
            job.emit("error", f"{type(e).__name__}: {e}")
            job.status = "error"
        finally:
            after = stl_mtimes(project_dir)
            changed = sorted(n for n, t in after.items() if before.get(n) != t)
            added = sorted(n for n in after if n not in before)
            job.result = {"changed": changed, "added": added, "chat_id": chat_id}
            if changed:
                job.emit("activity", "Updated: " + ", ".join(changed), changed=changed)

    threading.Thread(target=run, daemon=True).start()
    return job, chat_id


def cancel_job(job_id):
    job = JOBS.get(job_id)
    if not job:
        return False
    job.cancelled = True
    if job.proc and job.proc.poll() is None:
        job.proc.terminate()
    return True


# --- Backend: Claude Code CLI ------------------------------------------

def _summarize_tool_use(name, inp):
    inp = inp or {}
    for key in ("file_path", "path", "command", "pattern", "description"):
        if key in inp:
            val = str(inp[key])
            return f"{name}: {val[:160]}"
    return name


OAUTH_PREFIX = "sk-ant-oat"


def claude_code_env(settings):
    """Environment for the `claude` child process.

    Drops an enclosing Claude Code session's identity (CLAUDECODE,
    CLAUDE_CODE_* except a user-provided OAuth token). Auth, in order:
    the OAuth token from settings; a Claude subscription OAuth token
    (sk-ant-oat…) that was exported as ANTHROPIC_API_KEY, moved to
    CLAUDE_CODE_OAUTH_TOKEN where Claude Code expects it; otherwise the
    environment's API key only if "pass API key" is on, else the user's
    stored `claude` login.
    """
    env = {k: v for k, v in os.environ.items()
           if not (k == "CLAUDECODE" or k == "CLAUDE_PID"
                   or (k.startswith("CLAUDE_CODE_") and k != "CLAUDE_CODE_OAUTH_TOKEN"))}
    api_key = env.pop("ANTHROPIC_API_KEY", None)
    auth_token = env.pop("ANTHROPIC_AUTH_TOKEN", None)
    if settings.get("cc_oauth_token"):
        env["CLAUDE_CODE_OAUTH_TOKEN"] = settings["cc_oauth_token"]
    elif api_key and api_key.startswith(OAUTH_PREFIX) and "CLAUDE_CODE_OAUTH_TOKEN" not in env:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = api_key
    elif settings.get("cc_inherit_api_key") == "1":
        if api_key:
            env["ANTHROPIC_API_KEY"] = api_key
        if auth_token:
            env["ANTHROPIC_AUTH_TOKEN"] = auth_token
    return env


def run_claude_code(job, settings, chat_id, project_dir, text, ctx, image_name):
    exe = settings["cc_path"] or "claude"
    image_path = str(IMAGES_DIR / image_name) if image_name else None
    prompt = build_prompt(text, ctx, image_path)
    if image_path:
        prompt += "\n\nRead the screenshot file first to see what the user sees."

    cmd = [exe, "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--add-dir", str(IMAGES_DIR),
           "--append-system-prompt", BASE_INSTRUCTIONS + ("\n" + settings["system_extra"] if settings["system_extra"] else "")]
    if settings["cc_permission_mode"]:
        cmd += ["--permission-mode", settings["cc_permission_mode"]]
    tools = shlex.split(settings["cc_allowed_tools"] or "")
    if tools:
        cmd += ["--allowedTools", *tools]
    if settings["cc_model"]:
        cmd += ["--model", settings["cc_model"]]
    chat = get_chat(chat_id)
    if chat.get("session_id"):
        cmd += ["--resume", chat["session_id"]]

    env = claude_code_env(settings)
    job.emit("activity", "Running Claude Code…", persist=False)
    job.proc = subprocess.Popen(
        cmd, cwd=str(project_dir), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL, text=True, bufsize=1,
    )
    final_text = None
    is_error = False
    for line in job.proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = ev.get("type")
        if ev.get("session_id") and t in ("system", "result"):
            update_chat(chat_id, session_id=ev["session_id"])
        if t == "assistant":
            for block in ev.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    job.emit("activity", _summarize_tool_use(block.get("name"), block.get("input")))
                elif block.get("type") == "text" and block.get("text", "").strip():
                    # Intermediate narration; the final answer comes in "result".
                    job.emit("progress", block["text"], persist=False)
        elif t == "result":
            final_text = ev.get("result") or ""
            is_error = bool(ev.get("is_error")) or ev.get("subtype") != "success"
            cost = ev.get("total_cost_usd")
            meta = {"cost_usd": cost} if cost is not None else {}
            if is_error:
                job.emit("error", final_text or f"Claude Code ended with {ev.get('subtype')}", **meta)
            else:
                job.emit("assistant", final_text, **meta)
    job.proc.wait()
    if job.cancelled:
        job.status = "cancelled"
        job.emit("error", "Cancelled.")
        return
    if final_text is None:
        err = job.proc.stderr.read().strip()
        job.emit("error", err[-2000:] or f"claude exited with code {job.proc.returncode}")
        job.status = "error"
    elif is_error:
        job.status = "error"


# --- Backend: Anthropic API --------------------------------------------

API_TOOLS = [
    {
        "name": "list_files",
        "description": "List files in the project folder (or a subfolder of it).",
        "input_schema": {
            "type": "object",
            "properties": {"subdir": {"type": "string", "description": "Relative subfolder; omit for the project root."}},
            "required": [],
        },
    },
    {
        "name": "read_file",
        "description": "Read a text file (e.g. a .scad source) from the project folder.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Path relative to the project folder."}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a text file in the project folder with the full new content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to the project folder."},
                "content": {"type": "string", "description": "Complete new file content."},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": "Replace one exact, unique occurrence of old_text with new_text in a project file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_text": {"type": "string"},
                "new_text": {"type": "string"},
            },
            "required": ["path", "old_text", "new_text"],
        },
    },
    {
        "name": "openscad_export",
        "description": "Render a .scad file to an .stl with OpenSCAD. Returns OpenSCAD's console output (echo/warnings/errors).",
        "input_schema": {
            "type": "object",
            "properties": {
                "scad": {"type": "string", "description": "Source .scad path relative to the project folder."},
                "stl": {"type": "string", "description": "Output .stl path relative to the project folder."},
            },
            "required": ["scad", "stl"],
        },
    },
    {
        "name": "openscad_preview",
        "description": "Render a .scad file to a PNG image so you can check the result visually.",
        "input_schema": {
            "type": "object",
            "properties": {
                "scad": {"type": "string"},
                "camera": {"type": "string", "description": "Optional OpenSCAD --camera value, e.g. 'eyex,eyey,eyez,cx,cy,cz'. Default auto-fits."},
            },
            "required": ["scad"],
        },
    },
]
for _t in API_TOOLS:
    _t["eager_input_streaming"] = True


class ToolError(Exception):
    pass


def _safe_path(project_dir: Path, rel):
    if not isinstance(rel, str) or not rel:
        raise ToolError("path must be a non-empty string")
    p = (project_dir / rel).resolve()
    try:
        p.relative_to(project_dir)
    except ValueError:
        raise ToolError("path escapes the project folder")
    return p


def _validate(tool_name, inp):
    schema = next((t["input_schema"] for t in API_TOOLS if t["name"] == tool_name), None)
    if schema is None:
        raise ToolError(f"unknown tool {tool_name}")
    if not isinstance(inp, dict):
        raise ToolError("INVALID_JSON: tool input was not an object")
    for key in schema["required"]:
        if not isinstance(inp.get(key), str):
            raise ToolError(f"INVALID_JSON: missing or non-string field '{key}' (input may be truncated)")


def _run_openscad(settings, args, timeout=300):
    proc = subprocess.run([find_openscad(settings), *args], capture_output=True, text=True, timeout=timeout)
    out = (proc.stdout + proc.stderr).strip()
    return proc.returncode, out[-4000:]


def exec_api_tool(job, settings, project_dir: Path, name, inp):
    """Returns tool_result content (str or list of blocks). Raises ToolError."""
    _validate(name, inp)
    if name == "list_files":
        base = _safe_path(project_dir, inp.get("subdir") or ".")
        if not base.is_dir():
            raise ToolError("not a directory")
        entries = sorted(base.iterdir(), key=lambda p: p.name.lower())
        return "\n".join(f"{p.name}/" if p.is_dir() else f"{p.name}  ({p.stat().st_size} B)"
                         for p in entries if not p.name.startswith(".")) or "(empty)"
    if name == "read_file":
        p = _safe_path(project_dir, inp["path"])
        if not p.is_file():
            raise ToolError("file not found")
        if p.suffix.lower() in (".stl", ".3mf", ".png"):
            raise ToolError("binary file; read the .scad source instead")
        return p.read_text(errors="replace")[:200_000]
    if name == "write_file":
        p = _safe_path(project_dir, inp["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(inp["content"])
        job.emit("activity", f"Wrote {inp['path']}")
        return f"Wrote {len(inp['content'])} chars to {inp['path']}"
    if name == "edit_file":
        p = _safe_path(project_dir, inp["path"])
        src = p.read_text()
        n = src.count(inp["old_text"])
        if n != 1:
            raise ToolError(f"old_text matched {n} times; it must match exactly once")
        p.write_text(src.replace(inp["old_text"], inp["new_text"], 1))
        job.emit("activity", f"Edited {inp['path']}")
        return "Edited."
    if name == "openscad_export":
        scad = _safe_path(project_dir, inp["scad"])
        stl = _safe_path(project_dir, inp["stl"])
        job.emit("activity", f"openscad → {inp['stl']}")
        # Render to a temp file first so a failed render never clobbers the
        # STL the viewer is showing.
        tmp = stl.with_name(f".{stl.stem}.rendering.stl")
        code, out = _run_openscad(settings, ["-o", str(tmp), str(scad)])
        if code != 0 or not tmp.exists():
            tmp.unlink(missing_ok=True)
            raise ToolError(f"OpenSCAD failed (exit {code}):\n{out}")
        os.replace(tmp, stl)
        return f"Exported {inp['stl']}.\n{out}"
    if name == "openscad_preview":
        scad = _safe_path(project_dir, inp["scad"])
        png = IMAGES_DIR / f"preview-{uuid.uuid4().hex[:8]}.png"
        args = ["-o", str(png), "--imgsize=1024,768", "--colorscheme=Tomorrow Night"]
        args += [f"--camera={inp['camera']}"] if inp.get("camera") else ["--autocenter", "--viewall"]
        job.emit("activity", f"Preview render of {inp['scad']}")
        code, out = _run_openscad(settings, args + [str(scad)])
        if code != 0 or not png.exists():
            raise ToolError(f"OpenSCAD preview failed (exit {code}):\n{out}")
        data = base64.standard_b64encode(png.read_bytes()).decode()
        png.unlink(missing_ok=True)
        return [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}},
            {"type": "text", "text": out or "Rendered."},
        ]
    raise ToolError(f"unknown tool {name}")


def _make_client(settings):
    import anthropic  # imported lazily so the viewer works without the SDK
    key = settings["api_key"] or os.environ.get("ANTHROPIC_API_KEY", "")
    if key.startswith(OAUTH_PREFIX):
        raise RuntimeError(
            "The configured key is a Claude subscription OAuth token (sk-ant-oat…), not an API key. "
            "Use the Claude Code backend, or enter an API key from console.anthropic.com.")
    if settings["api_key"]:
        return anthropic.Anthropic(api_key=settings["api_key"])
    return anthropic.Anthropic()


def _block_to_dict(block):
    return block.model_dump(mode="json", exclude_none=True)


def run_anthropic(job, settings, chat_id, project_dir, text, ctx, image_name):
    client = _make_client(settings)
    chat = get_chat(chat_id)
    # History is append-only: each turn's response.content is stored
    # verbatim (thinking blocks included) and replayed unchanged.
    messages = json.loads(chat["api_messages"]) if chat.get("api_messages") else []

    content = []
    if image_name:
        data = base64.standard_b64encode((IMAGES_DIR / image_name).read_bytes()).decode()
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}})
    content.append({"type": "text", "text": build_prompt(text, ctx, None)})
    messages.append({"role": "user", "content": content})

    model = settings["api_model"] or "claude-opus-5-5"
    system = BASE_INSTRUCTIONS + (
        "\nYou have tools to list/read/write/edit files in the project folder and to run OpenSCAD. "
        "Paths are relative to the project folder.\n")
    if settings["system_extra"]:
        system += "\n" + settings["system_extra"]

    kwargs = dict(
        model=model,
        max_tokens=int(settings["api_max_tokens"] or 32000),
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        tools=API_TOOLS,
        thinking={"type": "adaptive"},
        output_config={"effort": settings["api_effort"] or "high"},
    )
    if settings["api_fallbacks"] == "1" and model in FALLBACK_MODELS:
        kwargs["betas"] = ["server-side-fallback-2026-07-01"]
        kwargs["fallbacks"] = "default"

    for _ in range(40):  # hard cap on agent-loop iterations
        if job.cancelled:
            job.emit("error", "Cancelled.")
            job.status = "cancelled"
            break
        with client.beta.messages.stream(messages=messages, **kwargs) as stream:
            response = stream.get_final_message()
        messages.append({"role": "assistant", "content": [_block_to_dict(b) for b in response.content]})
        update_chat(chat_id, api_messages=json.dumps(messages))

        texts = [b.text for b in response.content if b.type == "text" and b.text.strip()]
        if response.stop_reason == "refusal":
            job.emit("error", "The model declined this request." + (f" ({texts[-1]})" if texts else ""))
            job.status = "error"
            break
        if response.stop_reason == "max_tokens":
            job.emit("error", "Hit max_tokens before finishing — raise it in settings or ask for a smaller change.")
            job.status = "error"
            break
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if response.stop_reason != "tool_use" or not tool_uses:
            job.emit("assistant", "\n\n".join(texts) or "(done)")
            break
        for t in texts:
            job.emit("progress", t, persist=False)

        results = []
        for tu in tool_uses:
            try:
                out = exec_api_tool(job, settings, project_dir, tu.name, tu.input)
                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": out})
            except (ToolError, OSError, subprocess.TimeoutExpired) as e:
                job.emit("activity", f"{tu.name} failed: {str(e)[:200]}")
                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": str(e), "is_error": True})
        messages.append({"role": "user", "content": results})
        update_chat(chat_id, api_messages=json.dumps(messages))
    else:
        job.emit("error", "Stopped after 40 tool rounds.")
        job.status = "error"


def test_connection():
    settings = get_settings()
    if settings["backend"] == "anthropic":
        client = _make_client(settings)
        m = client.models.retrieve(settings["api_model"] or "claude-opus-5-5")
        return f"OK — Anthropic API reachable, model {m.id}"
    exe = settings["cc_path"] or "claude"
    env = claude_code_env(settings)
    out = subprocess.run([exe, "-p", "Reply with just: ok", "--output-format", "json"],
                         capture_output=True, text=True, timeout=90, env=env,
                         cwd=str(Path.home()), stdin=subprocess.DEVNULL)
    try:
        res = json.loads(out.stdout)
    except json.JSONDecodeError:
        raise RuntimeError((out.stderr or out.stdout).strip()[-500:] or f"claude exited {out.returncode}")
    if res.get("is_error"):
        raise RuntimeError(res.get("result") or "claude reported an error")
    how = "OAuth token" if env.get("CLAUDE_CODE_OAUTH_TOKEN") else (
        "API key" if env.get("ANTHROPIC_API_KEY") else "claude login")
    return f"OK — Claude Code answered (auth: {how})"
