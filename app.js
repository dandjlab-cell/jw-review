/* ============================================================
   JW Review UX — vanilla JS app.
   Architecture spec: PLAN.md (D1-D14, two-tier save, fallback chain).
   Worker contract: /api/rows, /api/rows/:y/:p, /api/candidates,
   /api/draft, /api/render, /api/render-fallback, /api/history,
   /api/restore, /api/approve, /api/drive-image.
   ============================================================ */

"use strict";

/* ───────────────────────────── Constants ───────────────────────────── */

const LS = {
  REVIEWER: "jw-reviewer",
  WORKER_URL: "jw-worker-url",
  TOKEN: "jw-token",
  DRAFT: (y, p) => `jw-draft-${y}-${p}`,
  OFFLINE_QUEUE: "jw-offline-queue",
};

const DEBOUNCE_MS = 500;
const RENDER_IDLE_MS = 5000;
const RETRY_BACKOFFS_MS = [500, 1500, 5000];
const POLL_PROGRESS_MS = 30_000;

const FONT_MIN_PT = 56;
const FONT_MAX_PT = 76;
const FONT_STEP_PT = 2;

/* Brand+format → overlay PNG (live preview only). PLAN §12. */
const OVERLAY_MAP = {
  "Kitchn|Recipe":          "assets/overlays/kitchn_recipe_overlay.png",
  "Kitchn|Compilation":     "assets/overlays/kitchn_recipe_overlay.png",
  "AT|Compilation":         "assets/overlays/at_ht_compilation_overlay.png",
  /* AT|House Tour and AT|How To intentionally absent — PLAN §12. */
};

/* ─────────────────────── Settings / first-run flow ─────────────────────── */

// Hardcoded Worker URL — single production endpoint. Override via
// localStorage["jw-worker-url"] for local-dev pointing (advanced).
const WORKER_URL_DEFAULT = "https://jw-review-worker.dandjlab.workers.dev";

function getSettings() {
  return {
    reviewer:  localStorage.getItem(LS.REVIEWER) || "reviewer",
    workerUrl: localStorage.getItem(LS.WORKER_URL) || WORKER_URL_DEFAULT,
    token:     localStorage.getItem(LS.TOKEN) || "",
  };
}

function setSettings({ reviewer, workerUrl, token }) {
  if (reviewer != null)  localStorage.setItem(LS.REVIEWER, reviewer);
  if (workerUrl != null) localStorage.setItem(LS.WORKER_URL, workerUrl);
  if (token != null)     localStorage.setItem(LS.TOKEN, token);
}

// Only the password is required to enter. Reviewer name is optional (falls
// back to "reviewer"); Worker URL defaults to production.
function settingsComplete(s) {
  return !!s.token;
}

function openSettingsModal({ force = false } = {}) {
  const s = getSettings();
  $("#modal-reviewer").value = s.reviewer === "reviewer" ? "" : s.reviewer;
  $("#modal-token").value = s.token;
  // Only show the Worker URL field if it's been overridden away from the default.
  const showAdvanced = s.workerUrl !== WORKER_URL_DEFAULT;
  $("#modal-worker-url-row").hidden = !showAdvanced;
  if (showAdvanced) $("#modal-worker-url").value = s.workerUrl;
  // Cancel only available when reopening from the gear icon — not on first run.
  $("#modal-cancel").hidden = force;
  $("#settings-modal").hidden = false;
  setTimeout(() => $("#modal-token").focus(), 30);
}

function closeSettingsModal() {
  $("#settings-modal").hidden = true;
}

/* ─────────────────────── DOM helpers ─────────────────────── */

function $(sel, root = document)  { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => { t.hidden = true; }, 250);
  }, 2400);
}

/* ─────────────────────── API client ─────────────────────── */

class ApiClient {
  constructor() { this.refresh(); }
  refresh() {
    const s = getSettings();
    this.workerUrl = (s.workerUrl || "").replace(/\/+$/, "");
    this.token = s.token;
    this.reviewer = s.reviewer;
  }
  headers() {
    return {
      "X-JW-Token": this.token,
      "X-JW-User": this.reviewer,
    };
  }
  url(path) {
    return `${this.workerUrl}${path.startsWith("/") ? path : "/" + path}`;
  }
  async request(path, { method = "GET", body, signal } = {}) {
    if (!this.workerUrl) throw new Error("Worker URL not configured");
    const opts = {
      method,
      headers: { ...this.headers() },
      signal,
    };
    if (body !== undefined) {
      if (body instanceof Blob) {
        opts.body = body;
        opts.headers["Content-Type"] = body.type || "application/octet-stream";
      } else {
        opts.body = JSON.stringify(body);
        opts.headers["Content-Type"] = "application/json";
      }
    }
    const r = await fetch(this.url(path), opts);
    if (!r.ok) {
      let detail = "";
      try { detail = await r.text(); } catch {}
      throw Object.assign(new Error(`${method} ${path} → ${r.status} ${detail.slice(0, 200)}`), { status: r.status, detail });
    }
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return r.json();
    return r.text();
  }
  health() { return this.request("/health"); }
  listRows(year, filters = {}) {
    const q = new URLSearchParams({ year: String(year), ...filters });
    return this.request(`/api/rows?${q.toString()}`);
  }
  getRow(year, pid)         { return this.request(`/api/rows/${year}/${pid}`); }
  patchRow(year, pid, body) { return this.request(`/api/rows/${year}/${pid}`, { method: "PATCH", body }); }
  candidates(year, pid)     { return this.request(`/api/candidates/${year}/${pid}`); }
  driveImageUrl(fid, role)  { return this.url(`/api/drive-image/${fid}?role=${role || "other"}&t=${encodeURIComponent(this.token || "")}`); }
  saveDraft(year, pid, recipe)  { return this.request(`/api/draft/${year}/${pid}`,  { method: "POST", body: { recipe } }); }
  triggerRender(year, pid, body) { return this.request(`/api/render/${year}/${pid}`, { method: "POST", body }); }
  uploadFallback(year, pid, blob){ return this.request(`/api/render-fallback/${year}/${pid}`, { method: "POST", body: blob }); }
  history(year, pid)        { return this.request(`/api/history/${year}/${pid}`); }
  restore(year, pid, hid)   { return this.request(`/api/restore/${year}/${pid}`, { method: "POST", body: { history_id: hid } }); }
  approve(year, pid, action, reason) {
    const body = { action };
    if (reason) body.reason = reason;
    return this.request(`/api/approve/${year}/${pid}`, { method: "POST", body });
  }
}

const api = new ApiClient();

/* ─────────────────────── App state ─────────────────────── */

const state = {
  year: 2026,
  rows: [],            // [{ pid, title, thumb_fid, duration, format, push_status, review_status, brand }]
  rowIndex: new Map(), // pid → row
  filters: { status: new Set(["Ready", "Hold", "Uploaded", "Excluded"]), brand: new Set(["Kitchn", "AT"]), format: new Set(["Recipe", "House Tour", "Compilation", "How To"]) },
  search: "",
  selectedPid: null,
  currentRow: null,    // detailed row payload from /api/rows/:y/:p
  candidates: [],      // [{ file_id, gemini_rank, gemini_score }]
  candidatesPid: null, // pid that state.candidates belongs to (drops stale paints)
  rowInteractive: false, // true after Phase 2 paint finishes; blocks edits during the gap
  recipe: {            // current in-flight recipe (the live state)
    candidate_fid: null,
    thumbnail_title: "",
    video_title: "",
    brand: "",
    format: "",
    version: 1,
  },
  pipState: "idle",
  approximate: false,
  pendingRender: null, // { timeoutId }
  retryAttempt: 0,
  online: navigator.onLine,
};

// Monotonic counter for loadRow invocations — every async completion checks it
// and drops if the user has navigated to a different row in the meantime.
let loadRowToken = 0;

// Latency HUD (opt-in): enable via DevTools console:
//   localStorage.setItem("jw-perf-hud", "1"); location.reload();
const PERF = {
  enabled: (typeof localStorage !== "undefined") && localStorage.getItem("jw-perf-hud") === "1",
  marks: {},
  reset() { this.marks = {}; },
  mark(name) { if (this.enabled) this.marks[name] = performance.now(); },
  render() {
    if (!this.enabled) return;
    let hud = document.querySelector("#perf-hud");
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "perf-hud";
      document.body.appendChild(hud);
    }
    const t0 = this.marks.click;
    if (!Number.isFinite(t0)) return;
    const rows = [
      ["first paint", this.marks.firstPaint],
      ["getRow",      this.marks.getRowDone],
      ["candidates",  this.marks.candidatesDone],
      ["video meta",  this.marks.videoMetadata],
    ].filter(([_, v]) => Number.isFinite(v));
    hud.innerHTML = rows.map(([k, v]) => `<div>${k}: ${Math.round(v - t0)} ms</div>`).join("");
  },
};
// Expose for DevTools / external diagnostics. Safe — read-only inspection.
window.__PERF = PERF;

/* ─────────────────────── Routing (hash-based) ───────────────────────
   We use hash routing (#/2026/2603K016) for GitHub Pages compatibility —
   no server rewrites needed; the static index.html always loads, then
   the app reads location.hash to figure out what to render.
   ────────────────────────────────────────────────────────────────── */

function parseRoute() {
  const raw = location.hash.replace(/^#/, "");
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart.replace(/^\/+/, "").replace(/\/+$/, "");
  const segs = path.split("/").filter(Boolean);
  const params = new URLSearchParams(queryPart || "");
  if (segs.length === 0) return { kind: "home" };
  const year = parseInt(segs[0], 10);
  if (!year || year < 2000 || year > 2100) return { kind: "unknown" };
  if (segs.length === 1) return { kind: "list", year, query: params };
  if (segs[1] === "_history") return { kind: "history", year };
  return { kind: "row", year, pid: segs[1], query: params };
}

function navigate(path, replace = false) {
  // path is treated as the post-# fragment (e.g. "/2026/2603K016?status=Ready").
  const hash = "#" + (path.startsWith("/") ? path : "/" + path);
  if (replace) history.replaceState(null, "", hash);
  else if (location.hash !== hash) location.hash = hash;
  handleRoute();
}

function rowPath(year, pid) {
  const qs = filtersToQuery();
  return `/${year}/${pid}${qs ? `?${qs}` : ""}`;
}

function filtersToQuery() {
  const parts = [];
  const all = (group, full) => state.filters[group].size === full;
  if (!all("status", 4)) parts.push(`status=${[...state.filters.status].join(",")}`);
  if (!all("brand", 2)) parts.push(`brand=${[...state.filters.brand].join(",")}`);
  if (!all("format", 4)) parts.push(`format=${[...state.filters.format].join(",")}`);
  if (state.search) parts.push(`q=${encodeURIComponent(state.search)}`);
  return parts.join("&");
}

function applyFiltersFromQuery(query) {
  if (!query) return;
  const set = (group, raw) => {
    const vals = (raw || "").split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length) state.filters[group] = new Set(vals);
  };
  set("status", query.get("status"));
  set("brand", query.get("brand"));
  set("format", query.get("format"));
  if (query.get("q")) state.search = query.get("q");
}

async function handleRoute() {
  const r = parseRoute();
  if (r.kind === "home") return navigate("/2026", true);
  if (r.kind === "unknown") return; // leave whatever's painted
  if (r.kind === "history") {
    state.year = r.year;
    paintTopbar();
    paintCenterEmpty("Activity feed (Phase 6 — placeholder)", "Per-row history is available; click ⟲ History on the picked thumbnail.");
    return;
  }
  if (r.kind === "list") {
    state.year = r.year;
    applyFiltersFromQuery(r.query);
    paintTopbar();
    paintFilters();
    await loadRows();
    if (state.rows.length) {
      const first = filteredRows()[0];
      if (first) navigate(rowPath(state.year, first.pid), true);
    }
    return;
  }
  if (r.kind === "row") {
    state.year = r.year;
    applyFiltersFromQuery(r.query);
    paintTopbar();
    paintFilters();
    if (!state.rows.length) await loadRows();
    state.selectedPid = r.pid;
    paintRowList();
    await loadRow(r.pid);
    return;
  }
}

window.addEventListener("hashchange", handleRoute);

/* ─────────────────────── Topbar / progress ─────────────────────── */

function paintTopbar() {
  $("#topbar-title").textContent = `JW Seed ${state.year}`;
  document.title = `JW Review · ${state.year}`;
}

function paintProgress() {
  const all = filteredRows();
  const done = all.filter(r => r.review_status === "Approved" || r.push_status === "Uploaded").length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  $("#progress-meta").textContent = `${done} / ${all.length} reviewed`;
  $("#progress-fill").style.width = pct + "%";
}

/* ─────────────────────── Filters ─────────────────────── */

function paintFilters() {
  $$("#filter-status .mini").forEach(m => m.classList.toggle("on", state.filters.status.has(m.dataset.value)));
  $$("#filter-brand .mini").forEach(m  => m.classList.toggle("on", state.filters.brand.has(m.dataset.value)));
  $$("#filter-format .mini").forEach(m => m.classList.toggle("on", state.filters.format.has(m.dataset.value)));
  paintFilterCounts();
}

function paintFilterCounts() {
  const counts = { status: {}, brand: {}, format: {} };
  for (const r of state.rows) {
    const ps = pushStatusBucket(r.push_status);
    counts.status[ps] = (counts.status[ps] || 0) + 1;
    if (r.brand)  counts.brand[r.brand]   = (counts.brand[r.brand]   || 0) + 1;
    if (r.format) counts.format[r.format] = (counts.format[r.format] || 0) + 1;
  }
  for (const m of $$("#filter-status .mini")) m.querySelector(".num").textContent = counts.status[m.dataset.value] || 0;
  for (const m of $$("#filter-brand .mini"))  m.querySelector(".num").textContent = counts.brand[m.dataset.value]  || 0;
  for (const m of $$("#filter-format .mini")) m.querySelector(".num").textContent = counts.format[m.dataset.value] || 0;
}

function pushStatusBucket(ps) {
  if (!ps) return "Ready";
  if (ps.startsWith("Hold")) return "Hold";
  if (ps === "Excluded") return "Excluded";
  if (ps === "Uploaded") return "Uploaded";
  return "Ready";
}

function bindFilterClicks() {
  for (const group of ["status", "brand", "format"]) {
    $(`#filter-${group}`).addEventListener("click", e => {
      const m = e.target.closest(".mini");
      if (!m) return;
      const v = m.dataset.value;
      const set = state.filters[group];
      if (set.has(v)) set.delete(v); else set.add(v);
      if (set.size === 0) set.add(v); // never empty; revert
      paintFilters();
      paintRowList();
      paintProgress();
      if (state.selectedPid) navigate(rowPath(state.year, state.selectedPid), true);
    });
  }
}

/* ─────────────────────── Row list ─────────────────────── */

function filteredRows() {
  const q = state.search.toLowerCase().trim();
  return state.rows.filter(r => {
    if (!state.filters.status.has(pushStatusBucket(r.push_status))) return false;
    if (r.brand  && !state.filters.brand.has(r.brand))   return false;
    if (r.format && !state.filters.format.has(r.format)) return false;
    if (q) {
      const hay = `${r.pid} ${r.title} ${r.talent_name || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function paintRowList() {
  const list = $("#row-list");
  const rows = filteredRows();
  if (!rows.length) {
    list.innerHTML = `<div class="row-list-empty">No rows match these filters.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const r of rows) {
    const item = el("div", {
      class: "row-item" + (r.pid === state.selectedPid ? " selected" : ""),
      dataset: { pid: r.pid },
      onclick: () => navigate(rowPath(state.year, r.pid)),
    });
    const thumb = el("div", { class: "thumb" });
    if (r.thumb_fid) {
      const img = el("img", { src: api.driveImageUrl(r.thumb_fid, "thumbnail"), loading: "lazy", alt: "" });
      img.addEventListener("error", () => {
        thumb.innerHTML = "";
        thumb.append(el("div", { class: "thumb-empty" }, "no img"));
      });
      thumb.append(img);
    } else {
      thumb.append(el("div", { class: "thumb-empty" }, "no img"));
    }
    item.append(
      thumb,
      el("div", { class: "info" },
        el("div", { class: "pid" }, r.pid),
        el("div", { class: "title" }, r.title || "(untitled)"),
        el("div", { class: "meta" }, [r.format, r.duration].filter(Boolean).join(" · ")),
      ),
      el("span", { class: "dot " + dotClass(r.push_status) })
    );
    list.append(item);
  }
}

function dotClass(ps) {
  const b = pushStatusBucket(ps);
  if (b === "Ready") return "dot-ready";
  if (b === "Uploaded") return "dot-uploaded";
  if (b === "Excluded") return "dot-excluded";
  if (b === "Hold") return "dot-hold";
  return "dot-other";
}

async function loadRows() {
  try {
    // Always fetch the unfiltered set; filtering is purely client-side via
    // state.filters. Keeps the row list, pill counts, and search consistent
    // regardless of URL query params or pill state.
    const r = await api.listRows(state.year, {});
    state.rows = (r && r.rows) || [];
    state.rowIndex.clear();
    for (const row of state.rows) state.rowIndex.set(row.pid, row);
    paintRowList();
    paintFilterCounts();
    paintProgress();
  } catch (e) {
    console.error("loadRows failed", e);
    $("#row-list").innerHTML = `<div class="row-list-empty">Failed to load rows.<br><small>${escapeHtml(e.message || "")}</small></div>`;
    if (e.status === 401 || e.status === 403) toast("Auth failed — check token", "error");
  }
}

/* ─────────────────────── Center / row detail ─────────────────────── */

function paintCenterEmpty(title, meta) {
  $("#center-content").hidden = true;
  $("#rightpane").hidden = true;
  $("#center-empty").hidden = false;
  $(".center-empty-title", $("#center-empty")).textContent = title;
  $(".center-empty-meta",  $("#center-empty")).textContent = meta;
}

function paintCenterContent() {
  $("#center-empty").hidden = true;
  $("#center-content").hidden = false;
  $("#rightpane").hidden = false;
}

async function loadRow(pid) {
  const token = ++loadRowToken;
  PERF.reset(); PERF.mark("click");
  setRowInteractive(false);              // lock all mutation surfaces immediately
  // Reset per-row async state — drops stale prior-row candidates.
  state.candidates = [];
  state.candidatesPid = null;
  paintCandidates();

  // Phase 1: paint from the row-list summary we already have.
  const stub = state.rowIndex.get(pid);
  if (stub) {
    state.currentRow = stubToRowDetail(stub);
    initRecipeFromRow();
    paintRow();
    paintCenterContent();
    PERF.mark("firstPaint"); PERF.render();
    setPip("loading", "fetching…");
  } else {
    paintCenterEmpty("Loading…", pid);
  }

  // Phase 2: row + candidates fire in parallel.
  const rowP = api.getRow(state.year, pid);
  const candP = loadCandidates(pid, token).catch(err => console.warn("candidates load failed:", err));
  let realRow;
  try {
    realRow = await rowP;
  } catch (e) {
    if (token !== loadRowToken) return;   // user moved on — drop
    console.error("getRow failed", e);
    if (!stub) paintCenterEmpty("Failed to load row", e.message || "");
    else setPip("error", "row fetch failed");
    return;
  }
  if (token !== loadRowToken) return;     // stale completion — drop
  state.currentRow = realRow;
  initRecipeFromRow();
  paintRow();
  paintCandidates();                      // re-mark picked using real candidate_fid
  refreshPickedThumb();
  setRowInteractive(true);                // unlock now that real data has landed
  PERF.mark("getRowDone"); PERF.render();
  setPip("idle", "ready");
  recoverDraftIfAny();
  scheduleOverlayLayout();
  await candP;
}

// Build a row-detail-shaped object from the row-list summary, used for
// Phase 1 of loadRow before the real /api/rows/:y/:p response lands.
function stubToRowDetail(stub) {
  return {
    pid: stub.pid,
    project_number: stub.pid,
    title: stub.title || "",
    thumbnail_title: "",
    description: "", tags: "", branded: "", category: "", duration: stub.duration || "",
    format: stub.format || "", orientation: "", recipe_category: "", seasonal: "",
    series: "", site: stub.brand === "Kitchn" ? "The Kitchn" : "Apartment Therapy",
    sponsoring_brand: "", talent_name: "", talent_presence: "", tour_city: "",
    has_srt: "", review_status: stub.review_status || "", push_status: stub.push_status || "",
    candidate_fid: null, candidate_source: "stub",
    thumbnails_asset_fid: stub.thumb_fid || null,
    thumbnails_asset_url: "", drive_folder_url: "",
    video_asset_url: "", captions_asset_url: "",
    jw_id: "",
  };
}

// Single gate for all mutation surfaces. Called false at loadRow start,
// true after Phase 2 finishes.
function setRowInteractive(on) {
  state.rowInteractive = on;
  const center = $("#center");
  const right = $("#rightpane");
  for (const root of [center, right]) {
    if (!root) continue;
    for (const inp of root.querySelectorAll("input, select, textarea")) {
      inp.disabled = !on;
    }
  }
  for (const sel of [".btn.approve", ".btn.fix", ".btn.exclude"]) {
    const b = document.querySelector(sel);
    if (b) b.disabled = !on;
  }
  const tags = $("#tags-edit");
  if (tags) tags.classList.toggle("locked", !on);
}

function initRecipeFromRow() {
  const row = state.currentRow || {};
  state.recipe = {
    candidate_fid: row.candidate_fid || null,
    thumbnail_title: row.thumbnail_title || row.title || "",
    video_title: row.title || "",
    brand: row.brand || normalizeSiteToBrand(row.site),
    format: row.format || "",
    version: row.version || 1,
  };
  state.approximate = !!row.approximate;
  $("#approximate-banner").hidden = !state.approximate;
}

function normalizeSiteToBrand(site) {
  if (!site) return "";
  if (/kitchn/i.test(site)) return "Kitchn";
  if (/apartment\s*therapy/i.test(site)) return "AT";
  return site;
}

// Mirror of Worker sheets.ts:extractDriveFileId. Returns "" if no Drive id
// recognizable in URL. Used to pull the video file id from `video_asset_url`.
function extractDriveFileIdClient(url) {
  if (!url) return "";
  const REs = [
    /\/file\/d\/([a-zA-Z0-9_-]{16,})/,
    /\/folders\/([a-zA-Z0-9_-]{16,})/,
    /[?&]id=([a-zA-Z0-9_-]{16,})/,
    /\/d\/([a-zA-Z0-9_-]{16,})/,
  ];
  for (const re of REs) {
    const m = re.exec(url);
    if (m) return m[1];
  }
  return "";
}

function paintRow() {
  const row = state.currentRow || {};
  const recipe = state.recipe;

  // Header
  $("#row-pid").textContent = `${row.pid || "–"} · ${row.format || "–"} · ${row.site || row.brand || "–"}`;
  $("#row-title").textContent = row.title || "(untitled)";
  $("#row-meta").textContent = [
    row.duration,
    row.talent_name,
    row.jw_id ? `jw_id: ${row.jw_id}` : null,
  ].filter(Boolean).join(" · ");

  // Video — Worker-proxied Drive bytes via /api/drive-video. Same auth model
  // as /api/drive-image: shared token via ?t=, no per-user Drive sharing
  // needed (Worker streams via Dan's OAuth server-side).
  $("#video-duration").textContent = row.duration || "–";
  const videoFid = extractDriveFileIdClient(row.video_asset_url || row.video_asset || "");
  const videoEl = $("#video-el");
  if (videoFid) {
    videoEl.src = api.url(`/api/drive-video/${videoFid}?t=${encodeURIComponent(api.token || "")}`);
    videoEl.load();  // required after src change to actually fetch
    videoEl.onloadedmetadata = () => { PERF.mark("videoMetadata"); PERF.render(); };
  } else {
    videoEl.removeAttribute("src");
    videoEl.onloadedmetadata = null;
    videoEl.load();  // reset media element
  }

  // Picked thumbnail base
  refreshPickedThumb();

  // Title input
  $("#thumb-title-input").value = recipe.thumbnail_title || "";
  $("#overlay-title-text").textContent = recipe.thumbnail_title || "";

  // Right pane editorial
  setField("title", row.title);
  setField("description", row.description);
  paintTags(row.tags);

  // JW custom_params
  setField("site", row.site);
  setField("branded", row.branded);
  setField("format", row.format);
  setField("category", row.category);
  setField("duration", row.duration);
  setField("orientation", row.orientation);
  setField("recipe_category", row.recipe_category);
  setField("seasonal", row.seasonal);
  setField("series", row.series);
  setField("sponsoring_brand", row.sponsoring_brand);
  setField("talent_name", row.talent_name);
  setField("talent_presence", row.talent_presence);
  setField("tour_city", row.tour_city);
  setField("has_srt", row.has_srt);
  setField("review_status", row.review_status);

  paintLinks(row);
  paintOverlayPng();
}

function setField(name, value) {
  const elt = $(`[data-field="${name}"]`);
  if (!elt) return;
  if (elt.tagName === "SELECT") {
    elt.value = value || "";
  } else {
    elt.value = value == null ? "" : String(value);
  }
}

function getField(name) {
  const elt = $(`[data-field="${name}"]`);
  if (!elt) return "";
  return elt.value;
}

function paintTags(tags) {
  const root = $("#tags-edit");
  // Wipe everything except the trailing input.
  $$(".tag-chip", root).forEach(c => c.remove());
  const list = (Array.isArray(tags) ? tags : (tags || "").split(",").map(s => s.trim()).filter(Boolean));
  for (const tag of list) {
    const chip = el("span", { class: "tag-chip" }, tag,
      el("span", {
        class: "x", title: "Remove",
        onclick: () => { chip.remove(); onTagsChange(); }
      }, "✕")
    );
    root.insertBefore(chip, $(".tag-add", root));
  }
}

function readTags() {
  return $$(".tag-chip", $("#tags-edit")).map(c => c.textContent.replace(/\s*✕\s*$/, "").trim()).filter(Boolean);
}

function onTagsChange() {
  const tags = readTags();
  patchSheetField("tags", tags);
}

function paintLinks(row) {
  const urls = {
    drive_folder: row.drive_folder_url || row.drive_folder,
    video_asset: row.video_asset_url || row.video_asset,
    hero_file: row.candidate_fid ? api.driveImageUrl(row.candidate_fid, "hero") : null,
    thumbnails_asset: row.thumbnails_asset_url || (row.thumbnails_asset_fid ? api.driveImageUrl(row.thumbnails_asset_fid, "thumbnail") : null),
    captions_asset: row.captions_asset_url || row.captions_asset,
    jw_dashboard: row.jw_id ? `https://dashboard.jwplayer.com/p/${encodeURIComponent(row.jw_id)}` : null,
  };
  for (const a of $$(".link-pill")) {
    const k = a.dataset.key;
    const u = urls[k];
    if (u) {
      a.href = u;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.classList.remove("disabled");
    } else {
      a.removeAttribute("href");
      a.classList.add("disabled");
    }
  }
}

function paintOverlayPng() {
  const key = `${state.recipe.brand || ""}|${state.recipe.format || ""}`;
  const overlay = OVERLAY_MAP[key];
  const img = $("#overlay-png");
  if (overlay) {
    img.src = overlay;
    img.hidden = false;
    $("#overlay-title-text").style.visibility = "visible";
  } else {
    img.hidden = true;
    img.removeAttribute("src");
    $("#overlay-title-text").style.visibility = "hidden";
  }
}

function refreshPickedThumb({ cacheBust = false } = {}) {
  const fid = state.recipe.candidate_fid;
  const img = $("#picked-thumb-img");
  if (fid) {
    let url = api.driveImageUrl(fid, "hero");
    if (cacheBust) url += (url.includes("?") ? "&" : "?") + "v=" + Date.now();
    img.src = url;
  } else {
    img.removeAttribute("src");
  }
}

/* ─────────────────────── Live overlay layout ─────────────────────── */

function scheduleOverlayLayout() {
  // Two passes — once now (in case font already loaded), once after font load.
  fitOverlayText();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(fitOverlayText).catch(() => {});
  }
}

/**
 * Auto-shrink the overlay title to find the largest font that fits inside the card.
 * Mirrors dispatch_recipes.py's 76→56pt step-2pt loop.
 *
 * Container measurement: the .overlay-title element has a fixed inset (12.7%/87.3% horizontal,
 * 82.4%/92.3% vertical). We pick the largest pt size where:
 *   - text wraps to ≤ 2 lines
 *   - the wrapped block fits within the height
 */
function fitOverlayText() {
  const titleEl = $("#overlay-title-text");
  const box = $("#picked-thumb-box");
  if (!titleEl || !box) return;
  const containerH = box.clientHeight;
  if (!containerH) return;

  const text = titleEl.textContent || "";
  if (!text.trim()) {
    $("#picked-overlay-meta").textContent = "—";
    return;
  }

  // The CSS pt sizes in the spec are relative to a 1920px-tall production canvas.
  // Scale down to the rendered box height. Production: 76pt @ 1920h → 76 * (containerH/1920) px.
  const scaleToPx = pt => (pt * containerH) / 1920;

  // Reset to max
  let chosenPt = FONT_MIN_PT;
  let chosenLines = 99;

  // Probe largest first
  for (let pt = FONT_MAX_PT; pt >= FONT_MIN_PT; pt -= FONT_STEP_PT) {
    titleEl.style.fontSize = scaleToPx(pt) + "px";
    // Force layout
    const naturalH = titleEl.scrollHeight;
    const lineH = parseFloat(getComputedStyle(titleEl).lineHeight) || (scaleToPx(pt) * 1.05);
    const lines = Math.max(1, Math.round(naturalH / lineH));
    // Allow up to 3 lines — users can force breaks via Enter (textarea \n).
    const fits = naturalH <= titleEl.clientHeight + 1 && lines <= 3;
    if (fits) {
      chosenPt = pt;
      chosenLines = lines;
      break;
    }
  }
  // If nothing fit even at min, accept min and report whatever line count we observed.
  if (chosenLines === 99) {
    titleEl.style.fontSize = scaleToPx(FONT_MIN_PT) + "px";
    const naturalH = titleEl.scrollHeight;
    const lineH = parseFloat(getComputedStyle(titleEl).lineHeight) || (scaleToPx(FONT_MIN_PT) * 1.05);
    chosenLines = Math.max(1, Math.round(naturalH / lineH));
    chosenPt = FONT_MIN_PT;
  }
  $("#picked-overlay-meta").textContent = `${chosenPt}pt / ${chosenLines} ${chosenLines === 1 ? "line" : "lines"}`;
}

const fitOverlayDebounced = debounce(fitOverlayText, 60);
window.addEventListener("resize", fitOverlayDebounced);

/* ─────────────────────── Candidates ─────────────────────── */

async function loadCandidates(pid, token) {
  const strip = $("#candidate-strip");
  strip.innerHTML = `<div class="picker-empty">Loading candidates…</div>`;
  let cands;
  try {
    const r = await api.candidates(state.year, pid);
    if (token !== undefined && token !== loadRowToken) return; // stale — user moved on
    cands = (Array.isArray(r) ? r : (r && r.candidates)) || [];
  } catch (e) {
    if (token !== undefined && token !== loadRowToken) return;
    console.error("candidates failed", e);
    strip.innerHTML = `<div class="picker-empty">Failed to load candidates: ${escapeHtml(e.message || "")}</div>`;
    return;
  }
  state.candidates = cands;
  state.candidatesPid = pid;
  paintCandidates();
  PERF.mark("candidatesDone"); PERF.render();
}

function paintCandidates() {
  const strip = $("#candidate-strip");
  strip.innerHTML = "";
  const meta = $("#candidates-meta");
  if (!state.candidates.length) {
    strip.innerHTML = `<div class="picker-empty">No candidates returned.</div>`;
    meta.textContent = "0 candidates";
    return;
  }
  const pickedFid = state.recipe.candidate_fid;
  const pickIdx = state.candidates.findIndex(c => c.file_id === pickedFid);
  meta.textContent = `${state.candidates.length} candidates · Gemini-ranked${pickIdx >= 0 ? ` · current pick is #${pickIdx + 1}` : ""}`;
  for (const c of state.candidates) {
    const isPicked = c.file_id === pickedFid;
    const elt = el("div", {
      class: "candidate" + (isPicked ? " picked" : ""),
      dataset: { fid: c.file_id },
      onclick: () => onCandidateClick(c.file_id),
    });
    elt.append(el("img", { src: api.driveImageUrl(c.file_id, "candidate"), loading: "lazy", alt: "" }));
    if (isPicked) elt.append(el("div", { class: "badge-mini" }, "Picked"));
    if (c.gemini_rank != null) {
      const score = c.gemini_score != null ? ` · ${Number(c.gemini_score).toFixed(2)}` : "";
      elt.append(el("div", { class: "gemini-rank" }, `#${c.gemini_rank}${score}`));
    }
    strip.append(elt);
  }
}

function onCandidateClick(fid) {
  if (!fid) return;
  // Gate: candidates must belong to the current pid, and row must be interactive.
  if (!state.rowInteractive) return;
  if (state.candidatesPid !== state.selectedPid) return;
  if (fid === state.recipe.candidate_fid) return;
  state.recipe.candidate_fid = fid;
  // Instant preview swap (browser canvas — visible immediately).
  refreshPickedThumb();
  scheduleOverlayLayout();
  paintCandidates();
  saveDraftAndScheduleRender({ action: "pick_candidate", immediateRender: true });
}

/* ─────────────────────── Save logic ─────────────────────── */

function persistLocalDraft() {
  if (!state.selectedPid) return;
  try {
    localStorage.setItem(LS.DRAFT(state.year, state.selectedPid), JSON.stringify({
      ts: Date.now(),
      recipe: state.recipe,
    }));
  } catch (e) { /* quota — best-effort */ }
}

function clearLocalDraft() {
  if (!state.selectedPid) return;
  localStorage.removeItem(LS.DRAFT(state.year, state.selectedPid));
}

function recoverDraftIfAny() {
  if (!state.selectedPid) return;
  try {
    const raw = localStorage.getItem(LS.DRAFT(state.year, state.selectedPid));
    if (!raw) return;
    const { ts, recipe } = JSON.parse(raw);
    if (Date.now() - ts > 24 * 3600 * 1000) {
      clearLocalDraft();
      return;
    }
    // Recover only fields the server might not have (candidate_fid, thumbnail_title).
    if (recipe && recipe.candidate_fid && recipe.candidate_fid !== state.recipe.candidate_fid) {
      state.recipe.candidate_fid = recipe.candidate_fid;
      refreshPickedThumb();
      paintCandidates();
      toast("Recovered local draft", "");
    }
    if (recipe && recipe.thumbnail_title && recipe.thumbnail_title !== state.recipe.thumbnail_title) {
      state.recipe.thumbnail_title = recipe.thumbnail_title;
      $("#thumb-title-input").value = recipe.thumbnail_title;
      $("#overlay-title-text").textContent = recipe.thumbnail_title;
    }
    scheduleOverlayLayout();
  } catch (e) { /* ignore */ }
}

function setPip(state_, label) {
  const pip = $("#status-pip");
  const icons = { idle: "●", saved: "●", saving: "◐", approx: "⚡", retry: "⚠", offline: "✕" };
  pip.dataset.state = state_;
  $(".pip-icon", pip).textContent = icons[state_] || "●";
  $(".pip-label", pip).textContent = label || state_;
  state.pipState = state_;
}

/**
 * Tier 1: cheap save. Patches sheet for the named field, posts draft to KV, appends history.
 * For non-sheet fields (just `candidate_fid`), only posts draft.
 */
async function patchSheetField(field, value) {
  if (!state.selectedPid) return;
  state.currentRow = state.currentRow || {};
  state.currentRow[field] = value;
  persistLocalDraft();
  setPip("saving", "saving");
  try {
    if (FIELD_TO_SHEET_COL.hasOwnProperty(field)) {
      const header = FIELD_TO_HEADER[field];
      const action = DROPDOWN_FIELDS.has(field) ? "dropdown_change" : "recipe_save_blur";
      await api.patchRow(state.year, state.selectedPid, {
        updates: [{ header, value: String(value) }],
        action,
      });
    }
    // After PATCH we still post draft to update KV view of the recipe.
    await api.saveDraft(state.year, state.selectedPid, state.recipe);
    setPip("saved", "saved");
    state.retryAttempt = 0;
  } catch (e) {
    console.warn("patchSheetField failed", field, e);
    handleSaveFailure(e, () => patchSheetField(field, value));
  }
  // Update the row in the list (push status / title may have changed).
  const r = state.rowIndex.get(state.selectedPid);
  if (r) {
    if (field === "title") r.title = value;
    if (field === "format") r.format = value;
    if (field === "site") r.brand = normalizeSiteToBrand(value);
    if (field === "review_status") r.review_status = value;
    paintRowList();
    paintFilterCounts();
    paintProgress();
  }
}

const FIELD_TO_SHEET_COL = {
  title: "B", thumbnail_title: "D", description: "E", tags: "F",
  branded: "G", category: "H", duration: "I", format: "J",
  orientation: "K", recipe_category: "L", seasonal: "M", series: "N",
  site: "O", sponsoring_brand: "P", talent_name: "Q", talent_presence: "R",
  tour_city: "S", has_srt: "V", review_status: "A",
};

// Worker contract (parsePatchBody in routes/rows.ts) requires CANONICAL_HEADERS.
const FIELD_TO_HEADER = {
  title: "Title",
  thumbnail_title: "Thumbnail Title",
  description: "Description",
  tags: "Tags",
  branded: "Branded",
  category: "Category",
  duration: "Duration",
  format: "Format",
  orientation: "Orientation",
  recipe_category: "Recipe_Category",
  seasonal: "Seasonal",
  series: "Series",
  site: "Site",
  sponsoring_brand: "Sponsoring_Brand",
  talent_name: "Talent_Name",
  talent_presence: "Talent_Presence",
  tour_city: "Tour_City",
  has_srt: "Has SRT",
  review_status: "Review Status",
};

const DROPDOWN_FIELDS = new Set([
  "review_status", "site", "branded", "format", "category", "duration",
  "orientation", "recipe_category", "seasonal", "talent_presence", "has_srt",
]);

function saveDraftAndScheduleRender({ action, immediateRender = false }) {
  persistLocalDraft();
  setPip("saving", "saving");
  // Tier 1: post draft to KV + history.
  api.saveDraft(state.year, state.selectedPid, state.recipe)
    .then(() => {
      if (immediateRender) {
        return triggerRender();
      } else {
        scheduleIdleRender();
        setPip("saved", "draft saved");
      }
    })
    .catch(e => handleSaveFailure(e, () => saveDraftAndScheduleRender({ action, immediateRender })));
}

function scheduleIdleRender() {
  if (state.pendingRender) clearTimeout(state.pendingRender.timeoutId);
  const tid = setTimeout(triggerRender, RENDER_IDLE_MS);
  state.pendingRender = { timeoutId: tid };
}

async function triggerRender() {
  if (!state.selectedPid) return;
  if (state.pendingRender) clearTimeout(state.pendingRender.timeoutId);
  state.pendingRender = null;
  setPip("saving", "rendering");
  try {
    const result = await api.triggerRender(state.year, state.selectedPid, {
      recipe: state.recipe,
      existing_thumbnail_fid: state.currentRow?.thumbnails_asset_fid || null,
    });
    state.approximate = false;
    $("#approximate-banner").hidden = true;
    setPip("saved", "saved");
    // Cache-bust on the picked thumbnail so the canonical render appears.
    if (result && result.drive_file_id && state.currentRow) {
      state.currentRow.thumbnails_asset_fid = result.drive_file_id;
    }
    refreshPickedThumb({ cacheBust: true });
    state.retryAttempt = 0;
    clearLocalDraft();
  } catch (e) {
    console.warn("render failed", e);
    // Modal failure → browser canvas fallback.
    if (e.status >= 500 || e.status === 503 || e.name === "AbortError" || /timeout/i.test(e.message || "")) {
      try {
        const blob = await renderToCanvasBlob();
        if (blob) {
          await api.uploadFallback(state.year, state.selectedPid, blob);
          state.approximate = true;
          $("#approximate-banner").hidden = false;
          setPip("approx", "approximate");
          state.retryAttempt = 0;
          // Try Modal again later (simple retry on next state change).
          return;
        }
      } catch (fallbackErr) {
        console.warn("fallback upload failed", fallbackErr);
      }
    }
    handleSaveFailure(e, triggerRender);
  }
}

function handleSaveFailure(err, retryFn) {
  if (!state.online) {
    setPip("offline", "offline");
    return;
  }
  state.retryAttempt = Math.min(state.retryAttempt + 1, RETRY_BACKOFFS_MS.length);
  if (state.retryAttempt > RETRY_BACKOFFS_MS.length) {
    setPip("retry", "save failed");
    toast(`Save failed: ${err.message?.slice(0, 80) || "unknown"}`, "error");
    state.retryAttempt = 0;
    return;
  }
  setPip("retry", `retrying (${state.retryAttempt})`);
  const wait = RETRY_BACKOFFS_MS[state.retryAttempt - 1];
  setTimeout(retryFn, wait);
}

/**
 * Render the current overlay (picked thumb + overlay PNG + title text) to a JPEG blob.
 * Used as fallback when Modal /api/render is unavailable (PLAN §6).
 */
async function renderToCanvasBlob() {
  const heroImg = $("#picked-thumb-img");
  const overlayImg = $("#overlay-png");
  if (!heroImg.complete || !heroImg.naturalWidth) return null;

  // Production canvas ratio is 9:16 (1080×1920). Use a 1080-wide canvas for fidelity.
  const W = 1080, H = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  // 1. hero (cover)
  drawCover(ctx, heroImg, W, H);
  // 2. overlay
  if (!overlayImg.hidden && overlayImg.complete && overlayImg.naturalWidth) {
    drawCover(ctx, overlayImg, W, H);
  }
  // 3. title
  const title = $("#overlay-title-text").textContent || "";
  if (title) {
    // Pick the same pt size we settled on in the live preview — read from the meta badge.
    const meta = $("#picked-overlay-meta").textContent || "";
    const m = meta.match(/(\d+)pt/);
    const ptInProduction = m ? parseInt(m[1], 10) : 64;
    ctx.fillStyle = "#000";
    ctx.font = `bold ${ptInProduction}pt "Domaine Text", Charter, "Iowan Old Style", Georgia, serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Positioning: PLAN §10 — 12.7%-87.3% horizontal, 82.4%-92.3% vertical for 1-2 line case.
    const cx = W / 2;
    const cy = H * (0.824 + 0.923) / 2;
    const innerW = W * (0.873 - 0.127);
    drawWrappedText(ctx, title, cx, cy, innerW, ptInProduction * 1.05);
  }
  return await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.92));
}

function drawCover(ctx, img, W, H) {
  const ir = img.naturalWidth / img.naturalHeight;
  const cr = W / H;
  let sw, sh, sx, sy;
  if (ir > cr) {
    // image wider — crop sides
    sh = img.naturalHeight;
    sw = sh * cr;
    sx = (img.naturalWidth - sw) / 2;
    sy = 0;
  } else {
    sw = img.naturalWidth;
    sh = sw / cr;
    sx = 0;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
}

function drawWrappedText(ctx, text, cx, cy, maxW, lineH) {
  // Respect user-supplied \n as hard breaks; within each chunk, word-wrap to maxW.
  const userChunks = String(text).split(/\r?\n/);
  const lines = [];
  for (const chunk of userChunks) {
    const trimmed = chunk.trim();
    if (!trimmed) { lines.push(""); continue; }
    const words = trimmed.split(/\s+/);
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  const startY = cy - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineH));
}

/* ─────────────────────── Approve / Fix / Exclude ─────────────────────── */

async function doApproveAction(action, reason) {
  if (!state.selectedPid) return;
  setPip("saving", action);
  try {
    await api.approve(state.year, state.selectedPid, action, reason);
    setPip("saved", "saved");
    toast(`${action[0].toUpperCase() + action.slice(1)}d`, "success");
    // Update local row + advance to next.
    const r = state.rowIndex.get(state.selectedPid);
    if (r) {
      if (action === "approve") { r.review_status = "Approved"; r.push_status = "Ready"; }
      if (action === "fix")     { r.review_status = "Rejected"; r.push_status = `Hold: ${reason || "needs review"}`; }
      if (action === "exclude") { r.push_status = "Excluded"; }
      paintRowList();
      paintFilterCounts();
      paintProgress();
    }
    // Auto-advance.
    moveSelection(1);
  } catch (e) {
    console.warn("approve action failed", e);
    setPip("retry", "save failed");
    toast(`Failed: ${e.message?.slice(0, 80) || "unknown"}`, "error");
  }
}

/* ─────────────────────── History panel ─────────────────────── */

async function openHistoryPanel() {
  if (!state.selectedPid) return;
  $("#history-panel").hidden = false;
  const body = $("#history-panel-body");
  body.innerHTML = `<div class="history-empty">Loading…</div>`;
  try {
    const r = await api.history(state.year, state.selectedPid);
    const rows = (Array.isArray(r) ? r : (r && r.rows)) || [];
    if (!rows.length) {
      body.innerHTML = `<div class="history-empty">No history yet for this row.</div>`;
      return;
    }
    body.innerHTML = "";
    body.append(el("div", { class: "history-row now" },
      el("div", { class: "meta" }, el("span", { class: "action" }, "NOW"), "live"),
      el("div", { class: "delta" }, state.recipe.thumbnail_title || "(no title)"),
    ));
    for (const h of rows) {
      const restoreBtn = h.history_id ? el("button", {
        class: "restore-btn",
        onclick: () => doRestore(h.history_id),
      }, "Restore") : null;
      body.append(el("div", { class: "history-row" },
        el("div", { class: "meta" },
          el("span", { class: "action" }, h.action || "?"),
          `${formatTime(h.timestamp)} · ${h.user_email || "?"}`
        ),
        el("div", { class: "delta" }, summarizeChange(h)),
        restoreBtn,
      ));
    }
  } catch (e) {
    body.innerHTML = `<div class="history-empty">Failed: ${escapeHtml(e.message || "")}</div>`;
  }
}

function closeHistoryPanel() {
  $("#history-panel").hidden = true;
}

function formatTime(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return ts;
  }
}

function summarizeChange(h) {
  if (h.notes) return h.notes;
  const prev = h.prev_recipe || {}, next = h.new_recipe || {};
  const diffs = [];
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (prev[k] !== next[k]) diffs.push(`${k}: ${truncate(prev[k])} → ${truncate(next[k])}`);
  }
  return diffs.join("\n") || `${h.action || "change"}`;
}

function truncate(v, n = 30) {
  const s = v == null ? "—" : String(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function doRestore(historyId) {
  if (!state.selectedPid) return;
  setPip("saving", "restoring");
  try {
    await api.restore(state.year, state.selectedPid, historyId);
    setPip("saved", "restored");
    toast("Restored", "success");
    closeHistoryPanel();
    await loadRow(state.selectedPid);
  } catch (e) {
    setPip("retry", "restore failed");
    toast(`Restore failed: ${e.message?.slice(0, 80) || "unknown"}`, "error");
  }
}

/* ─────────────────────── Field bindings (right pane) ─────────────────────── */

function bindFieldEvents() {
  // Thumbnail title — live overlay + debounced sheet PATCH on blur.
  const ti = $("#thumb-title-input");
  ti.addEventListener("input", () => {
    state.recipe.thumbnail_title = ti.value;
    $("#overlay-title-text").textContent = ti.value;
    fitOverlayDebounced();
    persistLocalDraft();
  });
  ti.addEventListener("blur", () => {
    if (!state.selectedPid) return;
    if ((state.currentRow?.thumbnail_title || "") === ti.value) return;
    if (state.currentRow) state.currentRow.thumbnail_title = ti.value;
    patchSheetField("thumbnail_title", ti.value);
    saveDraftAndScheduleRender({ action: "recipe_save_blur" });
  });

  // Right-pane fields: text inputs / textareas debounced on blur, selects immediate.
  for (const elt of $$("[data-field]")) {
    if (elt.id === "thumb-title-input") continue;
    if (elt.id === "tags-edit") continue;
    if (elt.tagName === "SELECT") {
      elt.addEventListener("change", () => {
        const v = elt.value;
        if (state.currentRow) state.currentRow[elt.dataset.field] = v;
        // For `format` and `site`, recipe.brand/format need updating + overlay re-paint.
        if (elt.dataset.field === "format") { state.recipe.format = v; paintOverlayPng(); scheduleOverlayLayout(); }
        if (elt.dataset.field === "site")   { state.recipe.brand = normalizeSiteToBrand(v); paintOverlayPng(); scheduleOverlayLayout(); }
        patchSheetField(elt.dataset.field, v);
      });
    } else if (elt.tagName === "INPUT" || elt.tagName === "TEXTAREA") {
      const debouncedBlur = debounce(() => {
        const v = elt.value;
        if ((state.currentRow?.[elt.dataset.field] ?? "") === v) return;
        if (state.currentRow) state.currentRow[elt.dataset.field] = v;
        patchSheetField(elt.dataset.field, v);
      }, DEBOUNCE_MS);
      elt.addEventListener("blur", debouncedBlur);
      // input writes localStorage so tab-crash recovers.
      elt.addEventListener("input", () => persistLocalDraft());
    }
  }

  // Tag input: Enter adds, Backspace on empty removes last.
  const tagAdd = $("#tag-add-input");
  tagAdd.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = tagAdd.value.trim();
      if (!v) return;
      const root = $("#tags-edit");
      const existing = readTags();
      if (existing.includes(v)) { tagAdd.value = ""; return; }
      const chip = el("span", { class: "tag-chip" }, v,
        el("span", { class: "x", onclick: () => { chip.remove(); onTagsChange(); } }, "✕")
      );
      root.insertBefore(chip, tagAdd);
      tagAdd.value = "";
      onTagsChange();
    } else if (e.key === "Backspace" && !tagAdd.value) {
      const chips = $$(".tag-chip", $("#tags-edit"));
      if (chips.length) {
        chips[chips.length - 1].remove();
        onTagsChange();
      }
    }
  });

  // Approve / Fix / Exclude
  $$('[data-action]').forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "fix") {
        $("#fix-modal").hidden = false;
        $("#fix-reason").value = "";
        setTimeout(() => $("#fix-reason").focus(), 30);
      } else if (action === "exclude") {
        if (confirm(`Exclude ${state.selectedPid}?`)) doApproveAction("exclude");
      } else {
        doApproveAction("approve");
      }
    });
  });

  // History
  $("#history-btn").addEventListener("click", openHistoryPanel);
  $("#history-close").addEventListener("click", closeHistoryPanel);

  // Search
  $("#search-input").addEventListener("input", debounce(() => {
    state.search = $("#search-input").value;
    paintRowList();
    paintProgress();
  }, 200));
}

/* ─────────────────────── Settings + Modal bindings ─────────────────────── */

function bindModalEvents() {
  $("#settings-btn").addEventListener("click", () => openSettingsModal({ force: false }));

  $("#modal-save").addEventListener("click", () => {
    const token = $("#modal-token").value.trim();
    if (!token) {
      toast("Password required", "error");
      return;
    }
    const reviewer = $("#modal-reviewer").value.trim() || "reviewer";
    // Worker URL: only read from the input if the advanced row is visible AND
    // the user actually filled it; otherwise keep whatever is in localStorage
    // (which falls back to WORKER_URL_DEFAULT via getSettings).
    const advancedRow = $("#modal-worker-url-row");
    let workerUrl = null;
    if (advancedRow && !advancedRow.hidden) {
      const v = $("#modal-worker-url").value.trim().replace(/\/+$/, "");
      if (v) workerUrl = v;
    }
    setSettings({ reviewer, workerUrl, token });
    api.refresh();
    closeSettingsModal();
    toast("Signed in", "success");
    handleRoute(); // re-fetch
  });
  $("#modal-cancel").addEventListener("click", () => {
    if (settingsComplete(getSettings())) closeSettingsModal();
  });

  // Fix dialog
  $("#fix-confirm").addEventListener("click", () => {
    const reason = $("#fix-reason").value.trim() || "needs review";
    $("#fix-modal").hidden = true;
    doApproveAction("fix", reason);
  });
  $("#fix-cancel").addEventListener("click", () => {
    $("#fix-modal").hidden = true;
  });

  // Help
  $("#help-close").addEventListener("click", () => {
    $("#help-modal").hidden = true;
  });

  // Activity link
  $("#activity-link").addEventListener("click", e => {
    e.preventDefault();
    navigate(`/${state.year}/_history`);
  });
}

/* ─────────────────────── Keyboard shortcuts ─────────────────────── */

function bindKeyboard() {
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea, select")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "Escape") {
      if (!$("#settings-modal").hidden && settingsComplete(getSettings())) closeSettingsModal();
      $("#fix-modal").hidden = true;
      $("#help-modal").hidden = true;
      closeHistoryPanel();
      return;
    }
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
    else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
    else if (e.key === "a") { e.preventDefault(); if (state.rowInteractive) doApproveAction("approve"); }
    else if (e.key === "x") { e.preventDefault(); if (state.rowInteractive && confirm(`Exclude ${state.selectedPid}?`)) doApproveAction("exclude"); }
    else if (e.key === "/") { e.preventDefault(); $("#search-input").focus(); }
    else if (e.key === "?") { e.preventDefault(); $("#help-modal").hidden = false; }
  });
}

function moveSelection(delta) {
  const rows = filteredRows();
  if (!rows.length) return;
  const idx = rows.findIndex(r => r.pid === state.selectedPid);
  let next = idx + delta;
  if (next < 0) next = 0;
  if (next >= rows.length) next = rows.length - 1;
  if (rows[next] && rows[next].pid !== state.selectedPid) {
    navigate(rowPath(state.year, rows[next].pid));
  }
}

/* ─────────────────────── Network state ─────────────────────── */

window.addEventListener("online",  () => { state.online = true;  if (state.pipState === "offline") setPip("idle", "online"); });
window.addEventListener("offline", () => { state.online = false; setPip("offline", "offline"); });

/* ─────────────────────── Boot ─────────────────────── */

async function boot() {
  bindFilterClicks();
  bindFieldEvents();
  bindModalEvents();
  bindKeyboard();

  // First-run gate.
  if (!settingsComplete(getSettings())) {
    openSettingsModal({ force: true });
    // The Save button proceeds; nothing else to do.
    return;
  }
  api.refresh();
  await handleRoute();
  // Periodic progress refresh — cheap.
  setInterval(paintProgress, POLL_PROGRESS_MS);
}

document.addEventListener("DOMContentLoaded", boot);
