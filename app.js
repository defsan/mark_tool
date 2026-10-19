import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const PIN_COLORS = ["#e6553f", "#f2b544", "#5fc27e", "#4aa8e0", "#b57de0", "#e06fb0"];

const host = document.getElementById("canvas-host");
const rootPathEl = document.getElementById("root-path");
const projectSelect = document.getElementById("project-select");
const modelList = document.getElementById("model-list");
// Scrollable model list with a <select>-like interface (value, onchange),
// so the rest of the app can treat it like the dropdown it replaced.
const modelSelect = {
  _value: "",
  onchange: null,
  get value() { return this._value; },
  set value(path) {
    const items = [...modelList.querySelectorAll(".model-item")];
    if (!items.some((el) => el.dataset.path === path)) return;
    this._value = path;
    for (const el of items) {
      const on = el.dataset.path === path;
      el.classList.toggle("selected", on);
      el.setAttribute("aria-selected", on);
      if (on) el.scrollIntoView({ block: "nearest" });
    }
  },
  pick(path) {
    if (path === this._value) return;
    this.value = path;
    if (this.onchange) this.onchange();
  },
};

function formatMtime(mtime) {
  const d = new Date(mtime * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" });
}

modelList.addEventListener("click", (e) => {
  const item = e.target.closest(".model-item");
  if (item) modelSelect.pick(item.dataset.path);
});

modelList.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...modelList.querySelectorAll(".model-item")];
  const i = items.findIndex((el) => el.dataset.path === modelSelect.value);
  const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
  if (next) modelSelect.pick(next.dataset.path);
});
const statusEl = document.getElementById("status");
const pinsEl = document.getElementById("pins");
const emptyEl = document.getElementById("empty");
const hintEl = document.getElementById("hint");
const notesPanelEl = document.getElementById("notes-panel");
const faceToleranceRow = document.getElementById("face-tolerance-row");
const faceToleranceInput = document.getElementById("face-tolerance");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d22);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
host.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 0.9);
key.position.set(1, 2, 1.5);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.4);
fill.position.set(-1.5, -0.5, -1);
scene.add(fill);

const grid = new THREE.GridHelper(200, 20, 0x44474e, 0x2c2f36);
scene.add(grid);
const AXIS_LEN = 30;
const axes = new THREE.AxesHelper(AXIS_LEN);
scene.add(axes);

// "X"/"Y"/"Z" text sprites at the axis tips (children of `axes`, so they
// scale with it), colored like AxesHelper: X red, Y green, Z blue.
function makeAxisLabel(text, color) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 48px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#000";
  ctx.strokeText(text, 32, 34);
  ctx.fillStyle = color;
  ctx.fillText(text, 32, 34);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.setScalar(AXIS_LEN * 0.2);
  sprite.renderOrder = 10;
  return sprite;
}
for (const [text, color, dir] of [
  ["X", "#ff5555", [1, 0, 0]],
  ["Y", "#55ff55", [0, 1, 0]],
  ["Z", "#5599ff", [0, 0, 1]],
]) {
  const label = makeAxisLabel(text, color);
  label.position.set(...dir.map((d) => d * AXIS_LEN * 1.12));
  axes.add(label);
}

let mesh = null;
let boundRadius = 50;
let currentProject = null;
let currentRelPath = null;
let marks = [];
let markSeq = 0;
let mode = "pin";
let faceData = null; // { normals, adjacency } for the current mesh, built lazily

function resize() {
  const w = host.clientWidth;
  const h = host.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
// Observe the host rather than the window: the chat panel opening/closing
// changes the viewport width without a window resize.
new ResizeObserver(resize).observe(host);
resize();

function setStatus(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? "#7fd6a0" : "#e08a8a";
  if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ""; }, 4000);
}

function encodePath(relpath) {
  return relpath.split("/").map(encodeURIComponent).join("/");
}

function currentLabel() {
  if (!currentProject) return "";
  return currentProject === "." ? currentRelPath : `${currentProject}/${currentRelPath}`;
}

// Keeps the current project/model in the URL (via replaceState, so picking
// through models doesn't spam browser history) so a page refresh — or a
// bookmarked/shared link — reopens the same model instead of the first one.
function updateUrl(project, relpath) {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (relpath) params.set("model", relpath);
  const query = params.toString();
  history.replaceState(null, "", query ? `${location.pathname}?${query}` : location.pathname);
}

// --- Mode switching ----------------------------------------------------

const HINTS = {
  pin: "Click the model to drop a pin. Drag to orbit, scroll to zoom.",
  face: "Click a face to mark the whole flat region it belongs to (tune tolerance below first). Drag to orbit.",
  arrow: "Click-drag on the model to draw an arrow. Drag off the model to point it into empty space.",
};

function updateModeUI() {
  hintEl.textContent = HINTS[mode] || "";
  faceToleranceRow.style.display = mode === "face" ? "flex" : "none";
}

for (const el of document.querySelectorAll('input[name="mode"]')) {
  el.onchange = () => {
    mode = document.querySelector('input[name="mode"]:checked').value;
    updateModeUI();
  };
}
updateModeUI();

// --- Data loading -----------------------------------------------------------

let currentRoot = "";

async function fetchRoot() {
  const res = await fetch("/api/root", { cache: "no-store" });
  const data = await res.json();
  currentRoot = data.root;
  rootPathEl.textContent = `Library: ${data.root}`;
  rootPathEl.title = data.root;
}

async function fetchProjects() {
  const res = await fetch("/api/projects", { cache: "no-store" });
  return res.json();
}

async function fetchModels(project) {
  const res = await fetch(`/api/models?project=${encodeURIComponent(project)}`, { cache: "no-store" });
  if (!res.ok) return [];
  return res.json();
}

async function populateProjectSelect(preserve) {
  const projects = await fetchProjects();
  projectSelect.innerHTML = "";
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = `${p.label} (${p.count})`;
    projectSelect.appendChild(opt);
  }
  if (preserve && projects.some((p) => p.name === preserve)) {
    projectSelect.value = preserve;
  }
  return projects;
}

async function populateModelSelect(project, preserve) {
  const models = await fetchModels(project);
  modelList.innerHTML = "";
  modelSelect._value = "";
  for (const m of models) {
    const item = document.createElement("div");
    item.className = "model-item";
    item.setAttribute("role", "option");
    item.dataset.path = m.path;
    item.title = `${m.path}\nModified ${new Date(m.mtime * 1000).toLocaleString()}`;
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = m.path;
    const time = document.createElement("span");
    time.className = "model-time";
    time.textContent = formatMtime(m.mtime);
    item.append(name, time);
    modelList.appendChild(item);
  }
  if (!models.length) modelList.innerHTML = '<div class="model-empty">No .stl files</div>';
  if (models.length) {
    modelSelect.value = preserve && models.some((m) => m.path === preserve) ? preserve : models[0].path;
  }
  return models;
}

// --- Model rendering ----------------------------------------------------

// The mesh is left at its native STL/SCAD coordinates (never recentered) so
// pin coordinates match the source file exactly. Only the camera/controls
// target moves to frame the model.
function fitCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  boundRadius = Math.max(size.length() / 2, 1);
  camera.near = boundRadius / 100;
  camera.far = boundRadius * 100;
  camera.updateProjectionMatrix();
  camera.position.set(
    center.x + boundRadius * 1.6,
    center.y + boundRadius * 1.3,
    center.z + boundRadius * 1.8
  );
  controls.target.copy(center);
  controls.update();
  grid.scale.setScalar(Math.max(boundRadius / 50, 0.2));
  axes.scale.setScalar(Math.max(boundRadius / 50, 0.2));
}

async function loadModel(project, relpath, keepCamera) {
  // Tell the chat panel which model is selected up front, so it follows the
  // selection even if this load fails.
  if (project !== currentProject || relpath !== currentRelPath) {
    window.dispatchEvent(new CustomEvent("marktool:model", { detail: { project, model: relpath } }));
  }
  const url = `/api/model?project=${encodeURIComponent(project)}&path=${encodeURIComponent(relpath)}&t=${Date.now()}`;
  const loader = new STLLoader();
  let geometry;
  try {
    geometry = await loader.loadAsync(url);
  } catch (err) {
    setStatus(`Couldn't load ${relpath}: ${err.message}`, false);
    return;
  }
  geometry.computeVertexNormals();

  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }

  const material = new THREE.MeshStandardMaterial({ color: 0xcfd3da, metalness: 0.05, roughness: 0.7 });
  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  faceData = null; // rebuilt lazily on first face-mode click against this geometry
  applyViewMode();
  layoutSlicer();

  boundRadius = Math.max(new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).length() / 2, 1);
  if (!keepCamera) {
    fitCameraToObject(mesh);
  }
  relayoutMarks();

  currentProject = project;
  currentRelPath = relpath;
  updateUrl(project, relpath);
}

// --- View modes (toolbar): solid / x-ray / edges only ---------------------
//
// The mesh stays in the scene in every mode so raycasting (pins, faces,
// arrows) keeps working; only its material changes. Feature edges come from
// EdgesGeometry and are drawn twice: once depth-tested (visible edges) and
// once with an inverted depth test (hidden edges, dimmer), so in edges-only
// mode recesses and pockets behind the front walls stay readable. X-ray skips
// depth writes, so there every layer of wall and edge shows through equally.

const viewModeSelect = document.getElementById("view-mode");
const edgeAngleGroup = document.getElementById("edge-angle-group");
const edgeAngleInput = document.getElementById("edge-angle");
const VIEW_MODES = ["solid", "xray", "edges"];
let viewMode = "solid";
let edgeLines = null; // Group of { visible, hidden } LineSegments for the current mesh

const solidMaterialProps = { transparent: false, opacity: 1, depthWrite: true, colorWrite: true, side: THREE.FrontSide };

function rebuildEdges() {
  if (edgeLines) {
    scene.remove(edgeLines);
    edgeLines.children[0].geometry.dispose();
    for (const line of edgeLines.children) line.material.dispose();
    edgeLines = null;
  }
  if (!mesh || viewMode === "solid") return;
  const angle = Math.min(Math.max(parseFloat(edgeAngleInput.value) || 20, 1), 89);
  const geo = new THREE.EdgesGeometry(mesh.geometry, angle);
  const visible = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xe8ecf2 }));
  const hidden = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0x6f9be8, transparent: true, opacity: 0.45, depthFunc: THREE.GreaterDepth, depthWrite: false })
  );
  visible.raycast = hidden.raycast = () => {}; // never intercept clicks
  edgeLines = new THREE.Group();
  edgeLines.add(visible, hidden);
  scene.add(edgeLines);
}

function applyViewMode() {
  edgeAngleGroup.hidden = viewMode === "solid";
  if (mesh) {
    const m = mesh.material;
    Object.assign(m, solidMaterialProps);
    if (viewMode === "xray") {
      // No depth writes: every wall layer shows through, and all edges draw bright.
      Object.assign(m, { transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
    } else if (viewMode === "edges") {
      // Invisible, but still writes depth so front edges occlude back ones.
      Object.assign(m, { colorWrite: false });
    }
    // Push faces back slightly so edges lying on them win the depth test.
    Object.assign(m, { polygonOffset: viewMode !== "solid", polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    m.needsUpdate = true;
  }
  rebuildEdges();
}

function setViewMode(next) {
  if (!VIEW_MODES.includes(next)) return;
  viewMode = next;
  viewModeSelect.value = next;
  try { localStorage.setItem("marktool:viewMode", next); } catch {}
  applyViewMode();
}

viewModeSelect.addEventListener("change", () => setViewMode(viewModeSelect.value));
edgeAngleInput.addEventListener("change", () => {
  try { localStorage.setItem("marktool:edgeAngle", edgeAngleInput.value); } catch {}
  rebuildEdges();
});
window.addEventListener("keydown", (e) => {
  if (e.key !== "v" && e.key !== "V") return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  setViewMode(VIEW_MODES[(VIEW_MODES.indexOf(viewMode) + 1) % VIEW_MODES.length]);
});
try {
  const savedAngle = localStorage.getItem("marktool:edgeAngle");
  if (savedAngle) edgeAngleInput.value = savedAngle;
  const savedMode = localStorage.getItem("marktool:viewMode");
  if (VIEW_MODES.includes(savedMode)) viewMode = savedMode;
} catch {}
viewModeSelect.value = viewMode;
edgeAngleGroup.hidden = viewMode === "solid";

// --- Axes toggle (toolbar) --------------------------------------------------

const axesToggleBtn = document.getElementById("axes-toggle");
const axisLegendEl = document.getElementById("axis-legend");

function setAxesVisible(on) {
  axes.visible = on;
  axisLegendEl.hidden = !on;
  axesToggleBtn.classList.toggle("active", on);
  axesToggleBtn.setAttribute("aria-pressed", String(on));
  try { localStorage.setItem("marktool:axesVisible", on ? "1" : "0"); } catch {}
}

axesToggleBtn.addEventListener("click", () => setAxesVisible(!axes.visible));
try {
  if (localStorage.getItem("marktool:axesVisible") === "0") setAxesVisible(false);
} catch {}

// --- Slicer (toolbar) ---------------------------------------------------------
//
// Shows a large translucent slab perpendicular to the chosen axis that follows
// the mouse: over the model it snaps to the hit point, elsewhere it tracks the
// point on the axis (through the model centre) closest to the mouse ray. A click
// asks the server to intersect the model with that slab (OpenSCAD) and save the
// result as a new STL beside the model. While active, clicks don't place marks.

const slicerBtn = document.getElementById("slicer-toggle");
const slicerPanel = document.getElementById("slicer-panel");
const slicePlaneBtns = [...document.querySelectorAll("#slice-planes button")];
const sliceThicknessInput = document.getElementById("slice-thickness");
const slicePosInput = document.getElementById("slice-pos");
const slicePosLabel = document.getElementById("slice-pos-label");
const sliceSaveBtn = document.getElementById("slice-save");
const sliceResultEl = document.getElementById("slice-result");
const AXIS_INDEX = { x: 0, y: 1, z: 2 };
const SLICE_COLOR = 0xffb347;
renderer.localClippingEnabled = true; // for the slicer's in-slab highlight
const SLICER_HINT = "Slicer: move the mouse to place the slab, click to save it as a new STL. Drag to orbit, Esc to exit.";

let slicer = null; // { axis, pos, group, band } while the slicer is open
let sliceAxis = "z";
let sliceBusy = false;
let lastSlicePath = null;

function sliceThickness() {
  return Math.min(Math.max(parseFloat(sliceThicknessInput.value) || 2, 0.01), 1000);
}

function modelBox() {
  return mesh ? new THREE.Box3().setFromObject(mesh) : new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
}

function buildSlicerVisual() {
  const group = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const fill = new THREE.Mesh(
    box,
    new THREE.MeshBasicMaterial({ color: SLICE_COLOR, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false })
  );
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(box),
    new THREE.LineBasicMaterial({ color: SLICE_COLOR, transparent: true, opacity: 0.8 })
  );
  fill.raycast = outline.raycast = () => {};
  fill.renderOrder = outline.renderOrder = 5;
  group.add(fill, outline);
  return group;
}

// The model's surface inside the slab, drawn in the slice color on top of the
// mesh (shares its geometry; two clipping planes keep only the slab).
function buildSlicerBand() {
  const band = new THREE.Mesh(
    mesh ? mesh.geometry : new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      color: SLICE_COLOR, emissive: SLICE_COLOR, emissiveIntensity: 0.25, side: THREE.DoubleSide,
      clippingPlanes: [new THREE.Plane(), new THREE.Plane()],
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    })
  );
  band.raycast = () => {};
  band.renderOrder = 4;
  return band;
}

function disposeSlicerVisual() {
  scene.remove(slicer.group, slicer.band);
  for (const child of slicer.group.children) {
    child.geometry.dispose();
    child.material.dispose();
  }
  slicer.band.material.dispose(); // geometry belongs to the mesh
}

function layoutSlicer() {
  if (!slicer) return;
  const idx = AXIS_INDEX[slicer.axis];
  const box = modelBox();
  const center = box.getCenter(new THREE.Vector3());
  const extent = boundRadius * 4; // big enough to read as an infinite plane
  const scale = [extent, extent, extent];
  scale[idx] = sliceThickness();
  slicer.group.scale.set(...scale);
  center.setComponent(idx, slicer.pos);
  slicer.group.position.copy(center);
  if (mesh) slicer.band.geometry = mesh.geometry;
  const normal = new THREE.Vector3().setComponent(idx, 1);
  const [lower, upper] = slicer.band.material.clippingPlanes;
  lower.set(normal, -(slicer.pos - sliceThickness() / 2));
  upper.set(normal.clone().negate(), slicer.pos + sliceThickness() / 2);
  if (document.activeElement !== slicePosInput) slicePosInput.value = slicer.pos;
}

function setSlicePos(pos) {
  if (!slicer || !Number.isFinite(pos)) return;
  slicer.pos = Math.round(pos * 100) / 100;
  layoutSlicer();
}

function resetSlicePos() {
  const idx = AXIS_INDEX[sliceAxis];
  setSlicePos(Math.round(modelBox().getCenter(new THREE.Vector3()).getComponent(idx) * 10) / 10);
}

function setSliceAxis(axis) {
  sliceAxis = axis;
  for (const b of slicePlaneBtns) b.classList.toggle("active", b.dataset.axis === axis);
  slicePosLabel.textContent = axis.toUpperCase();
  try { localStorage.setItem("marktool:sliceAxis", axis); } catch {}
  if (slicer) {
    slicer.axis = axis;
    resetSlicePos();
  }
}

// Position along the slice axis under the mouse (0.1 mm steps).
function slicePosFromEvent(e) {
  const idx = AXIS_INDEX[slicer.axis];
  const hit = raycastMesh(e);
  if (hit) return Math.round(hit.point.getComponent(idx) * 10) / 10;
  setRaycasterFromEvent(e);
  // Closest point between the mouse ray and the axis line through the model centre.
  const box = modelBox();
  const q0 = box.getCenter(new THREE.Vector3());
  const v = new THREE.Vector3().setComponent(idx, 1);
  const u = raycaster.ray.direction;
  const w0 = new THREE.Vector3().subVectors(raycaster.ray.origin, q0);
  const b = u.dot(v), d = u.dot(w0), ee = v.dot(w0);
  const denom = 1 - b * b;
  if (denom < 1e-4) return null; // looking straight down the axis
  const t = (ee - b * d) / denom;
  const margin = sliceThickness();
  const pos = Math.min(Math.max(q0.getComponent(idx) + t, box.min.getComponent(idx) - margin), box.max.getComponent(idx) + margin);
  return Math.round(pos * 10) / 10;
}

function openSlicer() {
  if (slicer) return;
  slicer = { axis: sliceAxis, pos: 0, group: buildSlicerVisual(), band: buildSlicerBand() };
  scene.add(slicer.group, slicer.band);
  resetSlicePos();
  slicerPanel.hidden = false;
  slicerBtn.classList.add("active");
  slicerBtn.setAttribute("aria-pressed", "true");
  hintEl.textContent = SLICER_HINT;
}

function closeSlicer() {
  if (!slicer) return;
  disposeSlicerVisual();
  slicer = null;
  slicerPanel.hidden = true;
  slicerBtn.classList.remove("active");
  slicerBtn.setAttribute("aria-pressed", "false");
  updateModeUI();
}

async function saveSlice() {
  if (!slicer || sliceBusy || !currentRelPath) return;
  sliceBusy = true;
  sliceSaveBtn.disabled = true;
  const label = `${slicer.axis.toUpperCase()} = ${slicer.pos} mm, ${sliceThickness()} mm thick`;
  sliceSaveBtn.textContent = "Slicing…";
  try {
    const res = await fetch("/api/slice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: currentProject, model: currentRelPath,
        axis: slicer.axis, pos: slicer.pos, thickness: sliceThickness(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lastSlicePath = data.path;
    sliceResultEl.querySelector("span").textContent = `Saved ${data.path}`;
    sliceResultEl.hidden = false;
    setStatus(`Saved slice (${label}): ${data.path}`);
    await populateModelSelect(currentProject, currentRelPath);
  } catch (err) {
    setStatus(`Slice failed: ${err.message}`, false);
  } finally {
    sliceBusy = false;
    sliceSaveBtn.disabled = false;
    sliceSaveBtn.textContent = "Save slice as STL";
  }
}

slicerBtn.addEventListener("click", () => (slicer ? closeSlicer() : openSlicer()));
document.getElementById("slicer-close").addEventListener("click", closeSlicer);
for (const b of slicePlaneBtns) b.addEventListener("click", () => setSliceAxis(b.dataset.axis));
sliceThicknessInput.addEventListener("input", () => {
  try { localStorage.setItem("marktool:sliceThickness", sliceThicknessInput.value); } catch {}
  layoutSlicer();
});
slicePosInput.addEventListener("input", () => setSlicePos(parseFloat(slicePosInput.value)));
slicePosInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSlice(); });
sliceSaveBtn.addEventListener("click", saveSlice);
sliceResultEl.querySelector("button").addEventListener("click", async () => {
  if (!lastSlicePath) return;
  await populateModelSelect(currentProject, lastSlicePath);
  await loadModel(currentProject, lastSlicePath, true);
});
window.addEventListener("keydown", (e) => {
  if (slicer && e.key === "Escape" && (!e.target.closest?.("input, textarea, select") || slicerPanel.contains(e.target))) {
    closeSlicer();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.key === "s" || e.key === "S") {
    slicer ? closeSlicer() : openSlicer();
  } else if (slicer && ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(e.key)) {
    e.preventDefault();
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : -1);
    setSlicePos(Math.round((slicer.pos + step) * 100) / 100);
  }
});
try {
  const savedAxis = localStorage.getItem("marktool:sliceAxis");
  if (savedAxis in AXIS_INDEX) sliceAxis = savedAxis;
  const savedThickness = localStorage.getItem("marktool:sliceThickness");
  if (savedThickness) sliceThicknessInput.value = savedThickness;
} catch {}
setSliceAxis(sliceAxis);

// --- Shared marker visuals (label sprite + numbered badge) -----------------

function makeLabelSprite(color) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false })
  );
  sprite.userData.ctx = ctx;
  sprite.userData.canvas = canvas;
  sprite.userData.texture = texture;
  return sprite;
}

function drawMarkLabel(sprite, color, number) {
  const ctx = sprite.userData.ctx;
  const canvas = sprite.userData.canvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#1b1d22";
  ctx.stroke();
  ctx.fillStyle = "#1b1d22";
  ctx.font = "bold 30px -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(number), 32, 34);
  sprite.userData.texture.needsUpdate = true;
}

// Offsets along a surface normal (not a fixed world "up") so the label
// clears the mesh instead of getting depth-clipped by curved geometry.
function layoutLabelAt(sprite, basePosition, normal) {
  const s = Math.max(boundRadius * 0.045, 0.5);
  const n = normal && normal.lengthSq() > 1e-8 ? normal : new THREE.Vector3(0, 1, 0);
  sprite.scale.setScalar(s * 1.6);
  sprite.position.copy(basePosition).addScaledVector(n, s * 1.8);
}

// --- Pins -----------------------------------------------------------------

function makePinMarker(color) {
  const group = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 16),
    new THREE.MeshBasicMaterial({ color, depthTest: true })
  );
  group.add(sphere);
  const sprite = makeLabelSprite(color);
  group.add(sprite);
  group.userData.sprite = sprite;
  group.userData.sphere = sphere;
  return group;
}

function layoutPinMarker(group) {
  const s = Math.max(boundRadius * 0.045, 0.5);
  const normal = group.userData.normal || new THREE.Vector3(0, 1, 0);
  group.userData.sphere.scale.setScalar(s * 0.35);
  group.userData.sphere.position.copy(normal).multiplyScalar(s * 0.15);
  group.userData.sprite.scale.setScalar(s * 1.6);
  group.userData.sprite.position.copy(normal).multiplyScalar(s * 1.8);
}

function addPin(point, normal) {
  markSeq += 1;
  const color = PIN_COLORS[(markSeq - 1) % PIN_COLORS.length];
  const group = makePinMarker(color);
  group.position.copy(point);
  group.userData.normal = normal.clone();
  scene.add(group);
  layoutPinMarker(group);
  drawMarkLabel(group.userData.sprite, color, markSeq);

  marks.push({ id: markSeq, type: "pin", position: point.clone(), normal: normal.clone(), comment: "", color, group });
  refreshMarksUI();
}

// --- Faces ------------------------------------------------------------

// Builds per-triangle face normals and an edge-adjacency graph for the
// current mesh's (non-indexed) geometry, by welding vertices that share a
// position. Cached per mesh load and reused across face clicks.
function buildFaceData(geometry) {
  const pos = geometry.attributes.position;
  const triCount = pos.count / 3;
  const normals = new Float32Array(triCount * 3);
  const vKey = (i) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    return `${Math.round(x * 1e4)}_${Math.round(y * 1e4)}_${Math.round(z * 1e4)}`;
  };
  const edgeMap = new Map();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const ab = new THREE.Vector3(), cb = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3, i1 = t * 3 + 1, i2 = t * 3 + 2;
    vA.fromBufferAttribute(pos, i0);
    vB.fromBufferAttribute(pos, i1);
    vC.fromBufferAttribute(pos, i2);
    cb.subVectors(vC, vB);
    ab.subVectors(vA, vB);
    cb.cross(ab).normalize();
    normals[t * 3] = cb.x;
    normals[t * 3 + 1] = cb.y;
    normals[t * 3 + 2] = cb.z;

    const k0 = vKey(i0), k1 = vKey(i1), k2 = vKey(i2);
    const edges = [[k0, k1], [k1, k2], [k2, k0]];
    for (const [a, b] of edges) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      let arr = edgeMap.get(key);
      if (!arr) { arr = []; edgeMap.set(key, arr); }
      arr.push(t);
    }
  }

  const adjacency = Array.from({ length: triCount }, () => []);
  for (const arr of edgeMap.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        adjacency[arr[i]].push(arr[j]);
        adjacency[arr[j]].push(arr[i]);
      }
    }
  }
  return { triCount, normals, adjacency };
}

function ensureFaceData() {
  if (!faceData && mesh) faceData = buildFaceData(mesh.geometry);
  return faceData;
}

// Flood-fills triangles connected (edge-adjacent) to the seed triangle whose
// normal stays within toleranceDeg of the *seed's* normal (not each step's
// immediate neighbor) — otherwise a curved, finely-faceted surface (e.g. a
// cylinder) would drift all the way around one small-angle step at a time.
function floodFillFace(seedTri, toleranceDeg) {
  const { normals, adjacency } = ensureFaceData();
  const cosTol = Math.cos(THREE.MathUtils.degToRad(toleranceDeg));
  const seedNormal = new THREE.Vector3(normals[seedTri * 3], normals[seedTri * 3 + 1], normals[seedTri * 3 + 2]);
  const visited = new Set([seedTri]);
  const stack = [seedTri];
  const n = new THREE.Vector3();
  while (stack.length) {
    const cur = stack.pop();
    for (const nb of adjacency[cur]) {
      if (visited.has(nb)) continue;
      n.set(normals[nb * 3], normals[nb * 3 + 1], normals[nb * 3 + 2]);
      if (n.dot(seedNormal) >= cosTol) {
        visited.add(nb);
        stack.push(nb);
      }
    }
  }
  return Array.from(visited);
}

function buildFaceHighlightMesh(triIndices, geometry, color) {
  const pos = geometry.attributes.position;
  const arr = new Float32Array(triIndices.length * 9);
  let o = 0;
  for (const t of triIndices) {
    for (let v = 0; v < 3; v++) {
      const i = t * 3 + v;
      arr[o++] = pos.getX(i);
      arr[o++] = pos.getY(i);
      arr[o++] = pos.getZ(i);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  return new THREE.Mesh(geo, mat);
}

function addFaceMark(triIndices, clickNormal, geometry) {
  markSeq += 1;
  const color = PIN_COLORS[(markSeq - 1) % PIN_COLORS.length];
  const highlight = buildFaceHighlightMesh(triIndices, geometry, color);
  scene.add(highlight);

  const pos = geometry.attributes.position;
  const centroid = new THREE.Vector3();
  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (const t of triIndices) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    centroid.add(a).add(b).add(c);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    area += ab.clone().cross(ac).length() * 0.5;
  }
  centroid.divideScalar(triIndices.length * 3);

  const label = makeLabelSprite(color);
  scene.add(label);
  drawMarkLabel(label, color, markSeq);
  layoutLabelAt(label, centroid, clickNormal);

  marks.push({
    id: markSeq, type: "face", triCount: triIndices.length, centroid: centroid.clone(),
    normal: clickNormal.clone(), area, comment: "", color, highlight, label,
  });
  refreshMarksUI();
}

// --- Arrows -----------------------------------------------------------

function addArrowMark(start, end, normal) {
  markSeq += 1;
  const color = PIN_COLORS[(markSeq - 1) % PIN_COLORS.length];
  const vec = new THREE.Vector3().subVectors(end, start);
  const length = Math.max(vec.length(), 0.0001);
  const dir = vec.clone().normalize();
  const headLength = Math.min(Math.max(length * 0.25, boundRadius * 0.02), length * 0.5);
  const headWidth = headLength * 0.6;
  const helper = new THREE.ArrowHelper(dir, start, length, color, headLength, headWidth);
  scene.add(helper);

  const label = makeLabelSprite(color);
  scene.add(label);
  drawMarkLabel(label, color, markSeq);
  const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  layoutLabelAt(label, mid, normal || dir);

  marks.push({ id: markSeq, type: "arrow", start: start.clone(), end: end.clone(), comment: "", color, helper, label });
  refreshMarksUI();
}

// --- Shared mark list / removal ---------------------------------------------

function disposeArrowHelper(helper) {
  helper.line.geometry.dispose();
  helper.line.material.dispose();
  helper.cone.geometry.dispose();
  helper.cone.material.dispose();
}

function removeMark(id) {
  const idx = marks.findIndex((m) => m.id === id);
  if (idx === -1) return;
  const m = marks[idx];
  if (m.type === "pin") {
    scene.remove(m.group);
  } else if (m.type === "face") {
    scene.remove(m.highlight);
    scene.remove(m.label);
    m.highlight.geometry.dispose();
    m.highlight.material.dispose();
  } else if (m.type === "arrow") {
    scene.remove(m.helper);
    scene.remove(m.label);
    disposeArrowHelper(m.helper);
  }
  marks.splice(idx, 1);
  refreshMarksUI();
}

function clearMarks() {
  for (const m of marks.slice()) removeMark(m.id);
}

// Re-applies label/badge scale after a model reload (new boundRadius) without
// touching the marks themselves — their world coordinates stay valid since
// the mesh is never recentered.
function relayoutMarks() {
  for (const m of marks) {
    if (m.type === "pin") {
      layoutPinMarker(m.group);
    } else if (m.type === "face") {
      layoutLabelAt(m.label, m.centroid, m.normal);
    } else if (m.type === "arrow") {
      const mid = new THREE.Vector3().addVectors(m.start, m.end).multiplyScalar(0.5);
      const dir = new THREE.Vector3().subVectors(m.end, m.start).normalize();
      layoutLabelAt(m.label, mid, dir);
    }
  }
}

function fmt(n) {
  return n.toFixed(2);
}

function summarizeMark(m) {
  if (m.type === "pin") return `(${fmt(m.position.x)}, ${fmt(m.position.y)}, ${fmt(m.position.z)}) mm`;
  if (m.type === "face") return `centroid (${fmt(m.centroid.x)}, ${fmt(m.centroid.y)}, ${fmt(m.centroid.z)}) mm · ${m.triCount} tri`;
  if (m.type === "arrow") return `(${fmt(m.start.x)}, ${fmt(m.start.y)}, ${fmt(m.start.z)}) → (${fmt(m.end.x)}, ${fmt(m.end.y)}, ${fmt(m.end.z)}) mm`;
  return "";
}

const PLACEHOLDERS = {
  pin: "What should change here?",
  face: "What should change on this face?",
  arrow: "What does this direction/length mean?",
};

function renderMarkList() {
  pinsEl.innerHTML = "";
  emptyEl.style.display = marks.length ? "none" : "block";
  for (const m of marks) {
    const card = document.createElement("div");
    card.className = "pin-card";

    const head = document.createElement("div");
    head.className = "head";
    const num = document.createElement("span");
    num.className = "num";
    num.style.background = m.color;
    num.textContent = m.id;
    const type = document.createElement("span");
    type.className = "type";
    type.textContent = m.type;
    const coords = document.createElement("span");
    coords.className = "coords";
    coords.textContent = summarizeMark(m);
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete mark";
    del.onclick = () => removeMark(m.id);
    head.append(num, type, coords, del);

    const textarea = document.createElement("textarea");
    textarea.placeholder = PLACEHOLDERS[m.type] || "";
    textarea.value = m.comment;
    textarea.oninput = () => { m.comment = textarea.value; renderNotesPanel(); };

    card.append(head, textarea);
    pinsEl.appendChild(card);
  }
}

// Live on-screen list of comments over the viewport (left side) — read-only,
// mirrors the sidebar's textareas so notes are visible while working without
// switching focus, and gives composeSnapshot() the same content to bake in.
function renderNotesPanel() {
  notesPanelEl.innerHTML = "";
  if (!marks.length) {
    notesPanelEl.style.display = "none";
    return;
  }
  notesPanelEl.style.display = "block";
  for (const m of marks) {
    const row = document.createElement("div");
    row.className = "note-row";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.style.background = m.color;
    badge.textContent = m.id;
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = m.comment.trim() || "(no comment)";
    row.append(badge, text);
    notesPanelEl.appendChild(row);
  }
}

function refreshMarksUI() {
  renderMarkList();
  renderNotesPanel();
}

// --- Pointer handling: click (pin/face) vs click-drag (arrow) vs orbit ------

const raycaster = new THREE.Raycaster();
let downPos = null;
let arrowDrag = null;

function setRaycasterFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
}

function raycastMesh(e) {
  if (!mesh) return null;
  setRaycasterFromEvent(e);
  const hits = raycaster.intersectObject(mesh, false);
  return hits.length ? hits[0] : null;
}

const dragPlaneNormal = new THREE.Vector3();
const dragPlane = new THREE.Plane();

// End point for an in-progress arrow drag: stays glued to the mesh surface
// while the pointer is over it, otherwise slides along a plane through the
// start point facing the camera so the arrow can point out into empty space.
function computeArrowEnd(e, start) {
  const hit = raycastMesh(e);
  if (hit) return hit.point.clone();
  camera.getWorldDirection(dragPlaneNormal);
  dragPlane.setFromNormalAndCoplanarPoint(dragPlaneNormal, start);
  const out = new THREE.Vector3();
  raycaster.ray.intersectPlane(dragPlane, out);
  return out || start.clone();
}

function updateArrowPreview(drag, end) {
  const vec = new THREE.Vector3().subVectors(end, drag.start);
  const length = Math.max(vec.length(), 0.0001);
  const dir = vec.lengthSq() > 1e-8 ? vec.clone().normalize() : new THREE.Vector3(0, 0, 1);
  const headLength = Math.min(Math.max(length * 0.25, boundRadius * 0.02), length * 0.5);
  const headWidth = headLength * 0.6;
  if (!drag.helper) {
    drag.helper = new THREE.ArrowHelper(dir, drag.start, length, 0xffe066, headLength, headWidth);
    scene.add(drag.helper);
  } else {
    drag.helper.setDirection(dir);
    drag.helper.setLength(length, headLength, headWidth);
  }
}

renderer.domElement.addEventListener("pointerdown", (e) => {
  downPos = { x: e.clientX, y: e.clientY };
  if (slicer) return;
  if (mode === "arrow") {
    const hit = raycastMesh(e);
    if (hit) {
      const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
      arrowDrag = { start: hit.point.clone(), normal, helper: null };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
    }
  }
});

renderer.domElement.addEventListener("pointermove", (e) => {
  if (slicer && e.buttons === 0 && !sliceBusy) {
    setSlicePos(slicePosFromEvent(e));
    return;
  }
  if (arrowDrag) {
    updateArrowPreview(arrowDrag, computeArrowEnd(e, arrowDrag.start));
  }
});

renderer.domElement.addEventListener("pointerup", (e) => {
  if (arrowDrag) {
    const drag = arrowDrag;
    arrowDrag = null;
    controls.enabled = true;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const end = computeArrowEnd(e, drag.start);
    if (drag.helper) {
      scene.remove(drag.helper);
      disposeArrowHelper(drag.helper);
    }
    const dist = downPos ? Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) : 0;
    downPos = null;
    if (dist > 6) addArrowMark(drag.start, end, drag.normal);
    return;
  }

  if (!downPos) return;
  const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (dist > 6 || !mesh) return;

  if (slicer) {
    if (!sliceBusy) {
      setSlicePos(slicePosFromEvent(e));
      saveSlice();
    }
    return;
  }

  const hit = raycastMesh(e);
  if (!hit) return;
  const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();

  if (mode === "pin") {
    addPin(hit.point, normal);
  } else if (mode === "face") {
    const tolerance = parseFloat(faceToleranceInput.value) || 3;
    const patch = floodFillFace(hit.faceIndex, tolerance);
    addFaceMark(patch, normal, mesh.geometry);
  }
});

// --- Snapshot composition ---------------------------------------------------

function markLegendHeader(m) {
  if (m.type === "pin") {
    return `Pin ${m.id}  (${fmt(m.position.x)}, ${fmt(m.position.y)}, ${fmt(m.position.z)}) mm`;
  }
  if (m.type === "face") {
    return `Face ${m.id}  centroid (${fmt(m.centroid.x)}, ${fmt(m.centroid.y)}, ${fmt(m.centroid.z)}) mm  normal (${fmt(m.normal.x)}, ${fmt(m.normal.y)}, ${fmt(m.normal.z)})  area ~${m.area.toFixed(1)} mm²  [${m.triCount} tri]`;
  }
  if (m.type === "arrow") {
    const vec = new THREE.Vector3().subVectors(m.end, m.start);
    const len = vec.length();
    const dir = len > 1e-6 ? vec.clone().normalize() : vec;
    return `Arrow ${m.id}  from (${fmt(m.start.x)}, ${fmt(m.start.y)}, ${fmt(m.start.z)})  to (${fmt(m.end.x)}, ${fmt(m.end.y)}, ${fmt(m.end.z)}) mm  len ${fmt(len)} mm  dir (${fmt(dir.x)}, ${fmt(dir.y)}, ${fmt(dir.z)})`;
  }
  return `Mark ${m.id}`;
}

// Greedy word-wrap against an already-configured ctx.font.
function wrapTextToWidth(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(test).width > maxWidth) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Builds the notes-panel content as {text, color}[] rows, word-wrapped to
// maxWidth using ctx's current font (ctx.font must already be set).
function buildLegendRows(ctx, maxWidth) {
  const rows = [{ text: `Model: ${currentLabel()}`, color: "#8b8f98" }, { text: "", color: null }];
  if (!marks.length) {
    rows.push({ text: "No marks placed.", color: "#c7cad1" });
    return rows;
  }
  for (const m of marks) {
    for (const line of wrapTextToWidth(ctx, markLegendHeader(m), maxWidth)) {
      rows.push({ text: line, color: m.color });
    }
    const comment = m.comment.trim() || "(no comment)";
    for (const line of wrapTextToWidth(ctx, comment, maxWidth - 12)) {
      rows.push({ text: `  ${line}`, color: "#c7cad1" });
    }
    rows.push({ text: "", color: null });
  }
  return rows;
}

// Renders the WebGL view plus a left-hand notes panel (same content as the
// on-screen list, but with full coordinates/vectors) into one canvas, so a
// single "Copy snapshot" carries both the picture and the notes.
function composeSnapshot() {
  // Axis letters are noise for the AI; the colored axis lines stay for orientation.
  for (const label of axes.children) label.visible = false;
  renderer.render(scene, camera);
  for (const label of axes.children) label.visible = true;
  const glCanvas = renderer.domElement;
  const dpr = window.devicePixelRatio || 1;

  const panelWidth = Math.round(300 * dpr);
  const padding = Math.round(12 * dpr);
  const lineHeight = Math.round(15 * dpr);
  const font = `${Math.round(11 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;

  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.font = font;
  const rows = buildLegendRows(measureCtx, panelWidth - padding * 2);

  const panelHeight = Math.max(glCanvas.height, padding * 2 + rows.length * lineHeight);

  const out = document.createElement("canvas");
  out.width = panelWidth + glCanvas.width;
  out.height = panelHeight;
  const ctx = out.getContext("2d");

  ctx.fillStyle = "#1b1d22";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = "#20232a";
  ctx.fillRect(0, 0, panelWidth, out.height);
  ctx.drawImage(glCanvas, panelWidth, 0);
  ctx.strokeStyle = "#34363c";
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(panelWidth, 0);
  ctx.lineTo(panelWidth, out.height);
  ctx.stroke();

  ctx.font = font;
  ctx.textBaseline = "top";
  let y = padding;
  for (const row of rows) {
    if (row.text) {
      ctx.fillStyle = row.color;
      ctx.fillText(row.text, padding, y);
    }
    y += lineHeight;
  }

  return out;
}

function notesAsText() {
  const lines = [`Model: ${currentLabel()}`];
  if (!marks.length) {
    lines.push("No marks placed.");
  } else {
    for (const m of marks) {
      lines.push(`${markLegendHeader(m)}: ${m.comment.trim() || "(no comment)"}`);
    }
  }
  return lines.join("\n");
}

document.getElementById("copy-snapshot-btn").onclick = async () => {
  const canvas = composeSnapshot();
  canvas.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setStatus("Snapshot copied to clipboard.");
    } catch (err) {
      setStatus("Clipboard copy failed — use Download instead.", false);
    }
  }, "image/png");
};

document.getElementById("download-snapshot-btn").onclick = () => {
  const canvas = composeSnapshot();
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${currentLabel().replace(/[\\/]/g, "-").replace(/\.stl$/i, "")}-marked.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
};

document.getElementById("copy-notes-btn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(notesAsText());
    setStatus("Notes copied as text.");
  } catch (err) {
    setStatus("Clipboard copy failed.", false);
  }
};

document.getElementById("clear-pins-btn").onclick = clearMarks;

async function reloadProjectsAndModel() {
  const prevProject = projectSelect.value;
  const prevModel = modelSelect.value;
  await populateProjectSelect(prevProject);
  const project = projectSelect.value;
  await populateModelSelect(project, project === prevProject ? prevModel : null);
  const relpath = modelSelect.value;
  if (relpath) {
    await loadModel(project, relpath, project === prevProject && relpath === prevModel);
    setStatus(`Reloaded ${currentLabel()}.`);
  }
}

document.getElementById("reload-btn").onclick = reloadProjectsAndModel;

// --- Library folder ("work folder") -------------------------------------------

const rootEditor = document.getElementById("root-editor");
const rootInput = document.getElementById("root-input");

function toggleRootEditor(open) {
  rootEditor.hidden = !open;
  if (open) {
    rootInput.value = currentRoot;
    rootInput.focus();
    rootInput.select();
  }
}

async function setLibraryRoot(path) {
  const res = await fetch("/api/root", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: path }),
  });
  const data = await res.json();
  if (!data.ok) {
    setStatus(data.error || "Could not set the library folder.", false);
    return;
  }
  toggleRootEditor(false);
  await fetchRoot();
  history.replaceState(null, "", location.pathname);
  const projects = await populateProjectSelect(null);
  if (!projects.length) {
    modelList.innerHTML = '<div class="model-empty">No .stl files</div>';
    setStatus("No .stl files found in the new library folder.", false);
    return;
  }
  await populateModelSelect(projectSelect.value, null);
  if (modelSelect.value) await loadModel(projectSelect.value, modelSelect.value, false);
  setStatus(`Library folder set to ${data.root}.`);
}

document.getElementById("root-change-btn").onclick = () => toggleRootEditor(rootEditor.hidden);
document.getElementById("root-cancel-btn").onclick = () => toggleRootEditor(false);
document.getElementById("root-set-btn").onclick = () => setLibraryRoot(rootInput.value.trim());
rootInput.addEventListener("keydown", (e) => {
  e.stopPropagation(); // keep typing out of the viewport shortcuts
  if (e.key === "Enter") setLibraryRoot(rootInput.value.trim());
  else if (e.key === "Escape") toggleRootEditor(false);
});
document.getElementById("root-browse-btn").onclick = async () => {
  const res = await fetch("/api/root/browse", { method: "POST", body: "{}" });
  const data = await res.json();
  if (!data.ok) setStatus(data.error || "Folder picker failed.", false);
  else if (data.path) rootInput.value = data.path;
};

// --- Bridge for the AI chat panel (chat.js) ----------------------------------

// Snapshot downscaled so its long edge fits what vision models use anyway;
// the exact mark coordinates travel separately as text.
function snapshotDataUrl(maxEdge = 1600) {
  const src = composeSnapshot();
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  if (scale === 1) return src.toDataURL("image/png");
  const out = document.createElement("canvas");
  out.width = Math.round(src.width * scale);
  out.height = Math.round(src.height * scale);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

const r2 = (v) => [v.x, v.y, v.z].map((n) => Number(n.toFixed(2)));

window.markTool = {
  current: () => {
    if (currentProject) return { project: currentProject, model: currentRelPath };
    return projectSelect.value && modelSelect.value ? { project: projectSelect.value, model: modelSelect.value } : null;
  },
  markCount: () => marks.length,
  notesAsText,
  snapshotDataUrl,
  camera: () => ({ position: r2(camera.position), target: r2(controls.target) }),
  reload: reloadProjectsAndModel,
  // Used by the ⌘K search palette (search.js).
  selectProject: async (project) => {
    projectSelect.value = project;
    if (projectSelect.value !== project) await populateProjectSelect(project);
    await projectSelect.onchange();
  },
  selectModel: async (project, model) => {
    if (projectSelect.value !== project) {
      projectSelect.value = project;
      if (projectSelect.value !== project) await populateProjectSelect(project);
    }
    await populateModelSelect(project, model);
    if (modelSelect.value) await loadModel(project, modelSelect.value, false);
  },
  clearMarks,
  setStatus,
};
window.dispatchEvent(new CustomEvent("marktool:ready"));

projectSelect.onchange = async () => {
  await populateModelSelect(projectSelect.value, null);
  if (modelSelect.value) await loadModel(projectSelect.value, modelSelect.value, false);
};

modelSelect.onchange = async () => {
  await loadModel(projectSelect.value, modelSelect.value, false);
};

// --- Boot --------------------------------------------------------------

(async function init() {
  await fetchRoot();
  const urlParams = new URLSearchParams(location.search);
  const wantProject = urlParams.get("project");
  const wantModel = urlParams.get("model");

  const projects = await populateProjectSelect(wantProject);
  if (!projects.length) {
    setStatus("No .stl files found under the configured library root.", false);
    return;
  }
  const models = await populateModelSelect(projectSelect.value, wantModel);
  if (models.length) {
    await loadModel(projectSelect.value, modelSelect.value, false);
  } else {
    setStatus("Selected project has no .stl files.", false);
  }
})();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
