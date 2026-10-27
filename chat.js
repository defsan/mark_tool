// AI chat panel: sends the user's message plus a screenshot, all marks, and
// the model path to the server, streams progress by polling the job, and
// reloads the model in the viewer when the AI finishes.

const $ = (id) => document.getElementById(id);
const panel = $("chat-panel");
const tab = $("chat-tab");
const msgsEl = $("chat-messages");
const emptyEl = $("chat-empty");
const input = $("chat-input");
const sendBtn = $("chat-send");
const stopBtn = $("chat-stop");
const attachBox = $("chat-attach");
const chatSelect = $("chat-select");
const backendLabel = $("chat-backend-label");

let settings = null;
let target = null;     // { project, model } shown in the viewer; model "" = empty folder
let chatId = null;
let job = null;        // { id, since, timer, workingEl, progressEl }

// --- Small helpers ---------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Just enough markdown for model replies: fenced code, inline code, bold, paragraphs.
function renderMarkdown(text) {
  const parts = text.split(/```[^\n]*\n?/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/\n$/, ""))}</code></pre>`;
    return escapeHtml(part).split(/\n{2,}/).filter((p) => p.trim()).map((p) =>
      "<p>" + p
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br/>") + "</p>").join("");
  }).join("");
}

function scrollToBottom() {
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function addMessageEl(role, text, extra = {}) {
  emptyEl.style.display = "none";
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (role === "user") {
    if (extra.image) {
      const img = document.createElement("img");
      img.src = extra.image;
      img.onclick = () => openLightbox(img.src);
      el.appendChild(img);
    }
    const t = document.createElement("div");
    t.textContent = text || "(marks only)";
    el.appendChild(t);
    if (extra.marks) {
      const m = document.createElement("div");
      m.className = "marks";
      m.textContent = extra.marks;
      el.appendChild(m);
    }
  } else if (role === "assistant") {
    el.innerHTML = renderMarkdown(text);
    if (extra.cost_usd != null) {
      const c = document.createElement("div");
      c.className = "cost";
      c.textContent = `$${Number(extra.cost_usd).toFixed(3)}`;
      el.appendChild(c);
    }
  } else {
    el.textContent = text;
  }
  msgsEl.appendChild(el);
  scrollToBottom();
  return el;
}

function openLightbox(src) {
  const lb = $("lightbox");
  lb.querySelector("img").src = src;
  lb.style.display = "flex";
}
$("lightbox").onclick = () => { $("lightbox").style.display = "none"; };

// --- Panel visibility ------------------------------------------------------

function setCollapsed(collapsed) {
  panel.classList.toggle("collapsed", collapsed);
  try { localStorage.setItem("marktool.chatCollapsed", collapsed ? "1" : "0"); } catch (e) { /* ignore */ }
}
$("chat-collapse").onclick = () => setCollapsed(true);
tab.onclick = () => { setCollapsed(false); input.focus(); };
try { if (localStorage.getItem("marktool.chatCollapsed") === "1") setCollapsed(true); } catch (e) { /* ignore */ }

// --- Conversations ---------------------------------------------------------

const EMPTY_HINTS = {
  model: { text: emptyEl.innerHTML, placeholder: input.placeholder },
  folder: {
    text: "This folder has no model yet.<br/>Describe the part you want, with sizes if you have them.<br/>The AI writes an OpenSCAD source and exports the STL here,<br/>then the viewer opens it.",
    placeholder: "e.g. A wall hook for a 20 mm rail, 60 mm long, 4 mm thick  (⌘/Ctrl+Enter to send)",
  },
};

// No model open = no screenshot or marks to send, and a "describe a new
// model" prompt instead of an edit prompt.
function applyTargetKind() {
  const hint = target && !target.model ? EMPTY_HINTS.folder : EMPTY_HINTS.model;
  emptyEl.innerHTML = hint.text;
  input.placeholder = hint.placeholder;
  attachBox.disabled = !!target && !target.model;
}

function clearMessages() {
  for (const el of [...msgsEl.querySelectorAll(".msg")]) el.remove();
  emptyEl.style.display = "block";
}

async function loadChatList(selectId, reopen = true) {
  chatSelect.innerHTML = "";
  if (!target) {
    chatSelect.innerHTML = "<option>Pick a model to start</option>";
    return;
  }
  const chats = await api(`/api/chats?project=${encodeURIComponent(target.project)}&model=${encodeURIComponent(target.model)}`);
  const fresh = document.createElement("option");
  fresh.value = "";
  fresh.textContent = "New conversation";
  chatSelect.appendChild(fresh);
  for (const c of chats) {
    const opt = document.createElement("option");
    opt.value = c.id;
    const when = new Date(c.updated_at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    opt.textContent = `${c.title || "Untitled"} · ${when}`;
    chatSelect.appendChild(opt);
  }
  const want = selectId !== undefined ? selectId : (chats[0] ? chats[0].id : "");
  chatSelect.value = want ? String(want) : "";
  if (reopen) await openChat(chatSelect.value ? Number(chatSelect.value) : null);
}

async function openChat(id) {
  chatId = id;
  clearMessages();
  if (!id) return;
  const { messages } = await api(`/api/chat?id=${id}`);
  for (const m of messages) {
    addMessageEl(m.role, m.content, {
      image: m.image ? `/chat-images/${encodeURIComponent(m.image)}` : null,
      marks: m.meta && m.meta.marks_text,
      cost_usd: m.meta && m.meta.cost_usd,
    });
  }
}

chatSelect.onchange = () => { if (!job) openChat(chatSelect.value ? Number(chatSelect.value) : null); };
$("chat-new").onclick = () => { if (job) return; chatSelect.value = ""; openChat(null); input.focus(); };
$("chat-delete").onclick = async () => {
  if (job || !chatId) return;
  if (!confirm("Delete this conversation?")) return;
  await api("/api/chat/delete", { id: chatId });
  await loadChatList("");
};

function onModelChange(detail) {
  if (!detail) return;
  if (target && target.project === detail.project && target.model === detail.model) return;
  target = detail;
  if (!job) {
    applyTargetKind();
    loadChatList().catch((err) => addMessageEl("error", `Couldn't load conversations: ${err.message}`));
  }
}
window.addEventListener("marktool:model", (e) => onModelChange(e.detail));
window.addEventListener("marktool:focus-chat", () => { setCollapsed(false); input.focus(); });

// --- Sending ----------------------------------------------------------------

function setBusy(busy) {
  sendBtn.disabled = busy;
  sendBtn.style.display = busy ? "none" : "";
  stopBtn.style.display = busy ? "inline-block" : "none";
  chatSelect.disabled = busy;
}

async function send() {
  const mt = window.markTool;
  if (job) return;
  if (!target && mt) onModelChange(mt.current());
  if (!mt || !target) {
    addMessageEl("error", "No folder selected — pick a folder on the right first.");
    return;
  }
  const text = input.value.trim();
  const hasModel = !!target.model;
  const hasMarks = hasModel && mt.markCount() > 0;
  if (!text && !hasMarks) { input.focus(); return; }

  const attach = attachBox.checked && hasModel;
  const image = attach ? mt.snapshotDataUrl() : null;
  const marksText = attach && hasMarks ? mt.notesAsText() : "";
  addMessageEl("user", text, { image, marks: marksText });
  input.value = "";

  let res;
  try {
    res = await api("/api/chat/send", {
      chat_id: chatId,
      project: target.project,
      model: target.model,
      text,
      image_b64: image,
      marks_text: marksText,
      camera: mt.camera(),
    });
  } catch (err) {
    addMessageEl("error", `Send failed: ${err.message}`);
    return;
  }
  if (res.chat_id !== chatId) {
    chatId = res.chat_id;
    // Refresh the dropdown only; the messages on screen are already current.
    await loadChatList(chatId, false);
  }
  const workingEl = document.createElement("div");
  workingEl.className = "msg working";
  workingEl.innerHTML = '<span class="spinner"></span><span>Working…</span>';
  msgsEl.appendChild(workingEl);
  scrollToBottom();
  job = { id: res.job_id, since: 0, workingEl, forTarget: { ...target } };
  setBusy(true);
  poll();
}

async function poll() {
  if (!job) return;
  let snap;
  try {
    snap = await api(`/api/job?id=${job.id}&since=${job.since}`);
  } catch (err) {
    job.timer = setTimeout(poll, 1500);
    return;
  }
  job.since = snap.next;
  for (const ev of snap.events) {
    if (ev.type === "progress") {
      // Show only the latest narration line under the spinner.
      job.workingEl.querySelector("span:last-child").textContent = ev.text.split("\n")[0].slice(0, 140);
      continue;
    }
    const el = addMessageEl(ev.type, ev.text, { cost_usd: ev.cost_usd });
    msgsEl.insertBefore(el, job.workingEl);
  }
  scrollToBottom();
  if (snap.status === "running") {
    job.timer = setTimeout(poll, 700);
    return;
  }
  await finishJob(snap);
}

async function finishJob(snap) {
  const done = job;
  job = null;
  done.workingEl.remove();
  setBusy(false);
  const mt = window.markTool;
  const result = snap.result || {};
  const changed = result.changed || [];
  const added = result.added || [];
  const same = target && done.forTarget.project === target.project && done.forTarget.model === target.model;
  if (!same) {
    // The user switched models mid-run; show that model's conversations now.
    await loadChatList();
  }
  if (!done.forTarget.model) {
    // Folder-level chat. If it produced a model, the server moved this
    // conversation onto it; open that model and keep the conversation.
    if (same && result.model) {
      target = { project: done.forTarget.project, model: result.model };
      applyTargetKind();
      await mt.selectModel(target.project, target.model);
      await loadChatList(chatId, false);
      mt.setStatus(`New model ${result.model} created.`);
    } else if (same && snap.status === "done") {
      mt.setStatus("AI finished — no model was created yet.", false);
    }
  } else if (settings && settings.auto_reload === "1" && same && (changed.includes(target.model) || added.length)) {
    await mt.reload();
    mt.setStatus(changed.includes(target.model) ? "Model updated by AI — reloaded." : "New models added — list refreshed.");
  } else if (snap.status === "done" && same && !changed.includes(target.model)) {
    mt.setStatus("AI finished — the model file didn't change.", false);
  }
  if (snap.status === "done" && changed.length && settings && settings.clear_marks_on_success === "1") {
    mt.clearMarks();
  }
  input.focus();
}

sendBtn.onclick = send;
stopBtn.onclick = () => { if (job) api("/api/job/cancel", { id: job.id }).catch(() => {}); };
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
});

// --- Settings ---------------------------------------------------------------

const overlay = $("settings-overlay");
const FIELDS = ["backend", "cc_path", "cc_model", "cc_permission_mode", "cc_allowed_tools", "cc_inherit_api_key", "cc_oauth_token", "api_key", "api_model",
  "api_effort", "api_max_tokens", "api_fallbacks", "openscad_path", "system_extra", "auto_reload", "clear_marks_on_success"];

function showBackendFieldsets() {
  const b = $("set-backend").value;
  for (const fs of document.querySelectorAll("#settings fieldset[data-backend]")) {
    fs.style.display = fs.dataset.backend === b ? "" : "none";
  }
}
$("set-backend").onchange = showBackendFieldsets;

function updateBackendLabel() {
  if (!settings) return;
  backendLabel.textContent = settings.backend === "anthropic"
    ? `Anthropic API · ${settings.api_model || "claude-opus-5-5"} · effort ${settings.api_effort}`
    : `Claude Code CLI${settings.cc_model ? ` · ${settings.cc_model}` : ""} · ${settings.cc_permission_mode}`;
}

function fillSettingsForm() {
  for (const k of FIELDS) {
    const el = $(`set-${k}`);
    if (el.type === "checkbox") el.checked = settings[k] === "1";
    else el.value = settings[k] ?? "";
  }
  showBackendFieldsets();
  $("settings-status").textContent = "";
}

function readSettingsForm() {
  const out = {};
  for (const k of FIELDS) {
    const el = $(`set-${k}`);
    out[k] = el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value.trim();
  }
  return out;
}

async function loadSettings() {
  settings = await api("/api/settings");
  updateBackendLabel();
}

$("chat-settings-btn").onclick = () => { fillSettingsForm(); overlay.classList.add("open"); };
$("settings-cancel").onclick = () => overlay.classList.remove("open");
overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove("open"); };
$("settings-save").onclick = async () => {
  settings = await api("/api/settings", readSettingsForm());
  updateBackendLabel();
  overlay.classList.remove("open");
};
$("settings-test").onclick = async () => {
  const st = $("settings-status");
  st.style.color = "#aeb3bc";
  st.textContent = "Testing…";
  try {
    settings = await api("/api/settings", readSettingsForm());
    updateBackendLabel();
    const r = await api("/api/settings/test", {});
    st.style.color = "#7fd6a0";
    st.textContent = r.message;
  } catch (err) {
    st.style.color = "#e08a8a";
    st.textContent = err.message;
  }
};

// --- Boot ----------------------------------------------------------------------

loadSettings().catch((err) => addMessageEl("error", `Settings unavailable: ${err.message}`));
if (window.markTool && window.markTool.current()) onModelChange(window.markTool.current());
else loadChatList();
