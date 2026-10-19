// ⌘K / Ctrl+K search palette: partial-match search over every project folder
// and .stl file in the library. Picking a folder switches the Project
// dropdown; picking a file switches Project and Model.

const $ = (id) => document.getElementById(id);
const overlay = $("search-overlay");
const input = $("search-input");
const resultsEl = $("search-results");
const scopeBtns = [...document.querySelectorAll("#search-scope button")];

const MAX_RESULTS = 100;
let index = null;      // [{ kind, project, file?, name, path, count? }]
let results = [];
let active = 0;
let scope = "all";     // all | folder | file

async function loadIndex() {
  const res = await fetch("/api/index", { cache: "no-store" });
  const projects = await res.json();
  const items = [];
  for (const p of projects) {
    const parts = p.name === "." ? [] : p.name.split("/");
    const folderName = parts.length ? parts.pop() : "(root files)";
    // A folder row's second line is where it lives, not its own name again.
    const parent = parts.length ? parts.join("/") : "Library";
    items.push({ kind: "folder", project: p.name, name: folderName, path: parent, count: p.files.length });
    for (const f of p.files) {
      items.push({ kind: "file", project: p.name, file: f, name: f, path: p.label });
    }
  }
  index = items;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Wraps every occurrence of any query token in <mark>.
function highlight(text, tokens) {
  if (!tokens.length) return escapeHtml(text);
  const lower = text.toLowerCase();
  const hit = new Array(text.length).fill(false);
  for (const t of tokens) {
    let i = lower.indexOf(t);
    while (i !== -1) {
      for (let k = i; k < i + t.length; k++) hit[k] = true;
      i = lower.indexOf(t, i + 1);
    }
  }
  let out = "";
  let open = false;
  for (let i = 0; i < text.length; i++) {
    if (hit[i] && !open) { out += "<mark>"; open = true; }
    if (!hit[i] && open) { out += "</mark>"; open = false; }
    out += escapeHtml(text[i]);
  }
  return open ? out + "</mark>" : out;
}

// Every whitespace-separated token must appear somewhere in the item's name
// or folder path (case-insensitive substring). Name hits outrank path hits;
// matches at the start of the name or of a word rank higher still.
function score(item, tokens) {
  const name = item.name.toLowerCase();
  const path = item.path.toLowerCase();
  let s = 0;
  for (const t of tokens) {
    const i = name.indexOf(t);
    if (i !== -1) {
      s += 10;
      if (i === 0) s += 6;
      else if (/[\s_\-./()]/.test(name[i - 1])) s += 3;
    } else if (path.includes(t)) {
      s += 3;
    } else {
      return -1;
    }
  }
  return s - name.length / 100;
}

function currentSelection() {
  return window.markTool && window.markTool.current();
}

function search() {
  if (!index) return;
  const tokens = input.value.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = index.filter((it) => scope === "all" || it.kind === scope);
  let list;
  if (!tokens.length) {
    // No query: folders first, then the current folder's files.
    const cur = currentSelection();
    list = pool.filter((it) => it.kind === "folder" || (cur && it.project === cur.project));
    list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1));
  } else {
    list = pool
      .map((it) => ({ it, s: score(it, tokens) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.it);
  }
  results = list.slice(0, MAX_RESULTS);
  active = 0;
  render(tokens);
}

function render(tokens) {
  resultsEl.innerHTML = "";
  if (!results.length) {
    resultsEl.innerHTML = `<div id="search-empty">No ${scope === "all" ? "folders or files" : scope + "s"} match.</div>`;
    return;
  }
  const cur = currentSelection();
  results.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "sr-item" + (i === active ? " active" : "");
    const isCurrent = cur && cur.project === it.project && (it.kind === "folder" || cur.model === it.file);
    row.innerHTML = `
      <span class="sr-icon">${it.kind === "folder" ? "&#128193;" : "&#128196;"}</span>
      <div class="sr-main">
        <div class="sr-name">${highlight(it.name, tokens)}</div>
        <div class="sr-path">${highlight(it.path, tokens)}</div>
      </div>
      ${isCurrent ? '<span class="sr-current">current</span>' : ""}
      ${it.kind === "folder" ? `<span class="sr-count">${it.count} file${it.count === 1 ? "" : "s"}</span>` : ""}`;
    row.onmousemove = () => { if (active !== i) setActive(i); };
    row.onclick = () => choose(it);
    resultsEl.appendChild(row);
  });
}

function setActive(i) {
  const rows = resultsEl.querySelectorAll(".sr-item");
  if (!rows.length) return;
  rows[active]?.classList.remove("active");
  active = (i + rows.length) % rows.length;
  rows[active].classList.add("active");
  rows[active].scrollIntoView({ block: "nearest" });
}

function setScope(s) {
  scope = s;
  for (const b of scopeBtns) b.classList.toggle("active", b.dataset.scope === s);
  search();
  input.focus();
}

async function choose(it) {
  close();
  const mt = window.markTool;
  if (!mt) return;
  if (it.kind === "folder") await mt.selectProject(it.project);
  else await mt.selectModel(it.project, it.file);
}

async function open() {
  overlay.classList.add("open");
  input.select();
  input.focus();
  try {
    await loadIndex(); // refreshed on every open so new files show up
  } catch (err) {
    resultsEl.innerHTML = `<div id="search-empty">Couldn't load the library index: ${escapeHtml(err.message)}</div>`;
    return;
  }
  search();
}

function close() {
  overlay.classList.remove("open");
}

const isOpen = () => overlay.classList.contains("open");

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (isOpen()) close(); else open();
    return;
  }
  if (!isOpen()) return;
  if (e.key === "Escape") { e.preventDefault(); close(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
  else if (e.key === "Enter") { e.preventDefault(); if (results[active]) choose(results[active]); }
  else if (e.key === "Tab") {
    e.preventDefault();
    const order = ["all", "folder", "file"];
    setScope(order[(order.indexOf(scope) + (e.shiftKey ? 2 : 1)) % 3]);
  }
});

input.addEventListener("input", search);
for (const b of scopeBtns) b.onclick = () => setScope(b.dataset.scope);
overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
$("search-open-btn").onclick = open;
