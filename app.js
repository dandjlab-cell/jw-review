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
const RENDER_IDLE_MS = 30000;   // 30s idle window — render only after the reviewer stops editing
const RETRY_BACKOFFS_MS = [500, 1500, 5000];
const POLL_PROGRESS_MS = 30_000;

const FONT_STEP_PT = 2;
const FONT_MIN_PT_DEFAULT = 56;
const FONT_MAX_PT_DEFAULT = 76;
// Back-compat aliases (some old code paths read these)
const FONT_MIN_PT = FONT_MIN_PT_DEFAULT;
const FONT_MAX_PT = FONT_MAX_PT_DEFAULT;

/* Brand+format → overlay PNG (live preview only). PLAN §12.
 * Formats without a dedicated overlay yet (Before & After, Promo, Advice)
 * fall back to a visually-close AT stand-in so SOMETHING renders. Reviewer
 * can override via the picker below the thumb. Replace with real PNGs when
 * the designer ships them. */
const OVERLAY_MAP = {
  "Kitchn|Recipe":          "assets/overlays/kitchn_recipe_overlay.png",
  "Kitchn|Compilation":     "assets/overlays/kitchn_recipe_overlay.png",
  "Kitchn|How To":          "assets/overlays/kitchn_recipe_overlay.png",
  "Kitchn|Promo":           "assets/overlays/kitchn_recipe_overlay.png",
  "Kitchn|Product Review":  "assets/overlays/kitchn_recipe_overlay.png",
  "Kitchn|Before & After":  "assets/overlays/kitchn_recipe_overlay.png",
  "Kitchn|Advice":          "assets/overlays/kitchn_recipe_overlay.png",
  "AT|Compilation":         "assets/overlays/at_ht_compilation_overlay.png",
  "AT|House Tour":          "assets/overlays/at_ht_overlay.png",
  "AT|How To":              "assets/overlays/at_diy_overlay.png",
  "AT|Product Review":      "assets/overlays/at_product_overlay.png",
  // Stand-ins until dedicated overlays ship.
  // Rules (per Dan, 2026-05-13):
  //   - For AT: Product Review + House Tour have dedicated overlays.
  //   - AT|Before & After uses the Compilation overlay because most B&As are
  //     house-tour-related (renovation / new place reveal).
  //   - AT|House Tour rows that LACK the 3-field data (Tour_City etc.) also
  //     fall back to Compilation at render time — handled dynamically in
  //     paintOverlayPng, not via this map.
  //   - Everything else (Promo, Advice, anything unmapped) → AT DIY yellow.
  "AT|Before & After":      "assets/overlays/at_ht_compilation_overlay.png",
  "AT|Promo":               "assets/overlays/at_diy_overlay.png",
  "AT|Advice":              "assets/overlays/at_diy_overlay.png",
};

/* Human-readable labels for the manual template-override picker. */
const OVERLAY_LABELS = {
  "Kitchn|Recipe":          "Kitchn Recipe",
  "Kitchn|Compilation":     "Kitchn Compilation",
  "AT|Compilation":         "AT Compilation",
  "AT|House Tour":          "AT House Tour",
  "AT|How To":              "AT How To",
  "AT|Product Review":      "AT Product Review",
};

/* Per-overlay title-area geometry + font bounds.
 * Mirrors the production renderers in ~/DevApps/jw-thumbnail-renderer/renderer/:
 *   - dispatch_recipes.py (Kitchn Recipe/Compilation)
 *   - dispatch_at_compilations.py (AT Compilation)
 *   - dispatch_at_house_tour.py (AT House Tour — uses the 3-field layout below)
 *   - AT How To (no production renderer yet — measured from the PNG; refine when renderer ships)
 *
 * `top/bot/left/right` are percentages of a 1080×1920 portrait canvas.
 * `fontMax/fontMin` are pt values relative to 1920h; the JS scales to box height.
 */
const OVERLAY_GEOM = {
  // CARD_Y=(1491,1801), LOGO_Y_BOTTOM=1570, PAD_TOP=12 PAD_BOT=28 → 1582..1773
  // CARD_X=(97,982), inner pad 40 → 137..942 = 12.7%..87.3%
  "Kitchn|Recipe":      { top: 82.4, bot: 7.7,  left: 12.7, right: 12.7, fontMax: 76, fontMin: 56 },
  "Kitchn|Compilation": { top: 82.4, bot: 7.7,  left: 12.7, right: 12.7, fontMax: 76, fontMin: 56 },
  // CARD_Y=(1435,1800), HEADER_Y_BOTTOM=1605, PAD_TOP=12 PAD_BOT=18 → 1617..1782
  // CARD_X=(64,1011), inner pad 50 → 114..961 = 10.6%..89.0%
  "AT|Compilation":     { top: 84.2, bot: 7.2,  left: 10.6, right: 11.0, fontMax: 64, fontMin: 44 },
  // 3-field layout — overlay-title hidden; overlay-ht-fields used instead. Use the
  // 3-field renderer's font range as a fallback safety size if anything else falls through.
  "AT|House Tour":      { top: 80.0, bot: 7.0,  left: 12.0, right: 12.0, fontMax: 41, fontMin: 28 },
  // AT|How To — no production renderer yet. Geometry pixel-measured from
  // at_diy_overlay.png (1080×1920): yellow card y=1547..1796 (80.6..93.5%),
  // apartment-therapy branding y=1576..1609 (82.1..83.8%), title safe area
  // y=1621..1768 → top:84.43%, bot:7.92%. Card x=135..943 (12.5..87.3%) with
  // 50px text pad → title x=185..893 → left:17.13%, right:17.31%.
  // Title area is shorter than Kitchn Recipe (147px vs 191px) so font max is
  // smaller (64pt mirrors AT Compilation).
  "AT|How To":          { top: 84.43,  bot: 7.92, left: 17.13, right: 17.31, fontMax: 64, fontMin: 44 },
  // AT|Product Review — pixel-measured from at_product_overlay.png:
  // blue card y=1544..1799 (80.4..93.7%), branding y=1586..1603 (82.6..83.5%),
  // title safe area y=1615..1771 → top:84.115%, bot:7.760%.
  // Card x=132..946 with 50px pad → left:16.85%, right:17.04%.
  "AT|Product Review":  { top: 84.115, bot: 7.76, left: 16.85, right: 17.04, fontMax: 64, fontMin: 44 },
  // Stand-in formats — borrow geometry from the overlay PNG they share.
  //   AT|Before & After uses the AT|Compilation pink card (house-tour alt).
  //   AT|Promo + AT|Advice use the AT|How To yellow card.
  //   Kitchn fallbacks reuse Kitchn|Recipe geometry.
  "AT|Before & After":  { top: 84.22, bot: 7.19, left: 10.56, right: 11.02, fontMax: 64, fontMin: 44 },
  "AT|Promo":           { top: 84.43, bot: 7.92, left: 17.13, right: 17.31, fontMax: 64, fontMin: 44 },
  "AT|Advice":          { top: 84.43, bot: 7.92, left: 17.13, right: 17.31, fontMax: 64, fontMin: 44 },
  "Kitchn|How To":         { top: 82.4, bot: 7.7, left: 12.7, right: 12.7, fontMax: 76, fontMin: 56 },
  "Kitchn|Promo":          { top: 82.4, bot: 7.7, left: 12.7, right: 12.7, fontMax: 76, fontMin: 56 },
  "Kitchn|Product Review": { top: 82.4, bot: 7.7, left: 12.7, right: 12.7, fontMax: 76, fontMin: 56 },
  "Kitchn|Before & After": { top: 82.4, bot: 7.7, left: 12.7, right: 12.7, fontMax: 76, fontMin: 56 },
  "Kitchn|Advice":         { top: 82.4, bot: 7.7, left: 12.7, right: 12.7, fontMax: 76, fontMin: 56 },
};

function getOverlayGeom(brand, format) {
  const key = `${brand}|${format}`;
  return OVERLAY_GEOM[key] || OVERLAY_GEOM["Kitchn|Recipe"];
}

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
  // Presence: POST = heartbeat for this tab, GET = list active viewers (60s TTL on the worker).
  presenceBeat(name) { return this.request("/api/presence", { method: "POST", body: { name } }); }
  presenceList()     { return this.request("/api/presence"); }
}

const api = new ApiClient();

/* ─────────────────────── App state ─────────────────────── */

const state = {
  year: 2026,
  rows: [],            // [{ pid, title, thumb_fid, duration, format, push_status, review_status, brand }]
  rowIndex: new Map(), // pid → row
  filters: {
    status: new Set(["Ready", "Hold", "Uploaded", "Excluded"]),
    brand: new Set(["Kitchn", "AT"]),
    format: new Set(["Recipe", "House Tour", "How To", "Promo", "Compilation", "Product Review", "Before & After", "Advice"]),
  },
  search: "",
  selectedPid: null,
  selectedRow: null,     // sheet row number — unique even for dup-pid variants;
                         // drives row-list selection class + J/K nav indexing.
  currentRow: null,    // detailed row payload from /api/rows/:y/:p
  candidates: [],      // [{ file_id, gemini_rank, gemini_score }]
  candidatesPid: null, // pid that state.candidates belongs to (drops stale paints)
  candidatesLoading: false, // true while /api/candidates is in flight
  candidatesAltsExpanded: false,
  candidatesFramesExpanded: false,
  overlayOverride: "", // brand|format key when reviewer manually selected a different template, else ""
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

// Latency HUD (opt-in for power users only): enable via URL query param
//   ?perf=1   (not localStorage anymore — the localStorage flag persisted
//             past intent and surfaced a debug overlay in normal reviews).
// One-time cleanup of the legacy localStorage flag.
try { if (typeof localStorage !== "undefined") localStorage.removeItem("jw-perf-hud"); } catch {}
const PERF = {
  enabled: (typeof location !== "undefined") && /[?&]perf=1\b/.test(location.search),
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
  // "full" means every default-on value is still in the set — no need to serialize.
  const FULL = { status: 4, brand: 2, format: 8 };
  const isFull = (group) => state.filters[group].size === FULL[group];
  if (!isFull("status")) parts.push(`status=${[...state.filters.status].join(",")}`);
  if (!isFull("brand"))  parts.push(`brand=${[...state.filters.brand].join(",")}`);
  if (!isFull("format")) parts.push(`format=${[...state.filters.format].join(",")}`);
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
    // Resolve selectedRow: keep current if it matches this pid (e.g., user
    // clicked a specific dup-pid variant); else pick the FIRST row with this pid.
    if (state.selectedRow != null) {
      const r2 = state.rows.find(x => x.row === state.selectedRow);
      if (!r2 || r2.pid !== r.pid) state.selectedRow = null;
    }
    if (state.selectedRow == null) {
      const firstMatch = state.rows.find(x => x.pid === r.pid);
      if (firstMatch) state.selectedRow = firstMatch.row;
    }
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

// Re-style the Approve button based on current row's review_status.
// "JW APPROVED" → button shows "↶ Un-approve" in outline style. Else → green primary.
// Also recognizes legacy "Approved" value for any rows not yet migrated.
function paintApproveButton() {
  const btn = $("#approve-btn");
  if (!btn) return;
  const r = state.rowIndex.get(state.selectedPid) || state.currentRow || {};
  const rs = (r.review_status || "").toUpperCase();
  const isApproved = (rs === "JW APPROVED" || rs === "APPROVED");
  if (isApproved) {
    btn.textContent = "↶ Un-approve";
    btn.classList.add("approved");
    btn.setAttribute("title", "Currently approved. Click to revert (Review Status + Push Status cleared).");
  } else {
    btn.textContent = "✓ Approve & Push to JW";
    btn.classList.remove("approved");
    btn.removeAttribute("title");
  }
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
    // Selection by row number (unique). For dup-pid rows this means only the
    // specific variant the user clicked highlights, not all rows sharing the pid.
    const isSelected = (state.selectedRow != null)
      ? (r.row === state.selectedRow)
      : (r.pid === state.selectedPid);
    const item = el("div", {
      class: "row-item" + (isSelected ? " selected" : ""),
      dataset: { pid: r.pid, row: r.row },
      onclick: () => {
        state.selectedRow = r.row;
        navigate(rowPath(state.year, r.pid));
      },
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
    const musicPill = musicPillFor(r.license_action, r.music_verdict);
    item.append(
      thumb,
      el("div", { class: "info" },
        el("div", { class: "pid" },
          el("span", { class: "row-num" }, `#${r.row}`),
          " · ",
          r.pid,
        ),
        el("div", { class: "title" }, r.title || "(untitled)"),
        el("div", { class: "meta" }, [r.format, r.duration].filter(Boolean).join(" · ")),
        musicPill ? el("div", { class: "music-row" }, musicPill) : "",
      ),
      el("span", { class: "dot " + dotClass(r.push_status) })
    );
    list.append(item);
  }
}

// Music status pill. License Action is the source of truth (swap/keep/add_music/
// flag_for_review); Music Verdict is the underlying ACR diagnosis. Returns a
// DOM node OR null when the row has no actionable music state.
function musicPillFor(licenseAction, musicVerdict) {
  const la = (licenseAction || "").trim().toLowerCase();
  const mv = (musicVerdict || "").trim().toLowerCase();
  // No music license info → no pill (keeps the list clean for the 188 rows
  // that aren't part of the swap workflow).
  if (!la && !mv) return null;
  let cls = "music-pill", label = "", title = "";
  if (la === "swap") {
    cls += " is-swap";
    label = "MUSIC SWAP";
    title = "Queued / in-progress music swap (WCPM library)";
  } else if (la === "swapped") {
    cls += " is-swapped";
    label = "SWAPPED";
    title = "Music swap complete — Video Asset points at new _JW.mp4 (WCPM)";
  } else if (la === "add_music" || la === "add music") {
    cls += " is-add";
    label = "ADD MUSIC";
    title = "No music in source — needs music added";
  } else if (la === "keep") {
    cls += " is-keep";
    label = "MUSIC OK";
    title = "Music kept (licensed or in WCPM)";
  } else if (la === "flag_for_review" || mv === "flagged" || mv === "risky_unknown") {
    cls += " is-flag";
    label = mv === "risky_unknown" ? "MUSIC ?" : "FLAGGED";
    title = "Music ID uncertain — human verify before push";
  } else if (mv === "not_music" || mv === "no_match") {
    return null;   // nothing actionable
  } else {
    return null;
  }
  return el("span", { class: cls, title }, label);
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
  state.candidatesLoading = true;          // about to fire /api/candidates
  state.candidatesAltsExpanded = false;
  state.candidatesFramesExpanded = false;  // re-collapse frame strip on row change
  state.overlayOverride = "";              // each row starts on Auto
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
  // Phase-1 stubs lack thumbnail_title; we must NOT fall back to row.title here
  // because that would flash the long Title in the overlay until the real row
  // lands and overwrites it. Leave thumbnail_title empty if not present yet —
  // the next initRecipeFromRow() call (after /api/rows resolves) will fill it.
  const hasStubOnly = !("thumbnail_title" in row);
  state.recipe = {
    candidate_fid: row.candidate_fid || null,
    thumbnail_title: hasStubOnly ? "" : (row.thumbnail_title || ""),
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

  // Approve-button label/style reflects current review_status.
  paintApproveButton();

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
    if (elt.tagName === "TEXTAREA") autoGrowTextarea(elt);
  }
}

// Grow a textarea to fit its content. Browsers that support `field-sizing:
// content` (Chrome 123+, Safari 18+) handle this in CSS; for older browsers
// this falls back to scrollHeight-based resize. Idempotent and cheap.
function autoGrowTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  // +2px avoids a flicker scrollbar at the boundary.
  el.style.height = (el.scrollHeight + 2) + "px";
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
  const override = state.overlayOverride || "";
  const autoKey = `${state.recipe.brand || ""}|${state.recipe.format || ""}`;
  // Overlay resolution (per Dan, 2026-05-13 — final):
  //   * AT|House Tour with a 3-field thumb_title (2+ `·` separators) → 3-field
  //     template. Reads "City · Sqft · HomeType" directly from the title text
  //     so rows with empty Tour_City column still render correctly when the
  //     title is in the canonical shape.
  //   * AT|House Tour without 3-field title → AT|Compilation pink fallback.
  //   * AT|Before & After + AT|Compilation → AT|Compilation pink always.
  //   * Other formats unchanged.
  let effectiveAutoKey = autoKey;
  const tbt = (state.recipe.thumbnail_title || "").trim();
  const has3FieldTitle = (tbt.match(/·/g) || []).length >= 2;
  if (autoKey === "AT|House Tour" && !has3FieldTitle) {
    effectiveAutoKey = "AT|Compilation";
  }
  const key = override || effectiveAutoKey;
  const overlay = OVERLAY_MAP[key];
  // Reflect override state on the picker.
  const sel = $("#overlay-override");
  if (sel) {
    if (sel.value !== override) sel.value = override;
    sel.classList.toggle("overridden", !!override);
  }
  const img = $("#overlay-png");
  // 3-field layout only when we actually have the data + are using the AT HT overlay.
  const isHT3field = (key === "AT|House Tour");
  if (overlay) {
    img.src = overlay;
    img.hidden = false;
    $("#overlay-title-text").style.visibility = isHT3field ? "hidden" : "visible";
    $("#overlay-ht-fields").hidden = !isHT3field;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
    $("#overlay-title-text").style.visibility = "hidden";
    $("#overlay-ht-fields").hidden = true;
  }
  // Apply per-overlay title-area geometry (matches the production renderer).
  // Uses the EFFECTIVE key so the geom matches the overlay PNG that's showing.
  const [gb, gf] = key.includes("|") ? key.split("|") : [state.recipe.brand, state.recipe.format];
  const geom = getOverlayGeom(gb, gf);
  const titleEl = $("#overlay-title-text");
  if (titleEl && !isHT3field) {
    titleEl.style.top    = geom.top + "%";
    titleEl.style.bottom = geom.bot + "%";
    titleEl.style.left   = geom.left + "%";
    titleEl.style.right  = geom.right + "%";
  }
  if (isHT3field) paintHouseTourFields();
}

/* Map a brand|format override key back to brand+format for geom lookup.
   Mirrors the rule in paintOverlayPng so fitOverlayText uses the same geom. */
function activeOverlayBrandFormat() {
  const override = state.overlayOverride || "";
  if (override && override.includes("|")) {
    const [b, f] = override.split("|");
    return { brand: b, format: f };
  }
  let brand = state.recipe.brand;
  let format = state.recipe.format;
  // HT auto-falls-back to Compilation only when thumb_title is NOT 3-field shape.
  const tbt = (state.recipe.thumbnail_title || "").trim();
  const has3FieldTitle = (tbt.match(/·/g) || []).length >= 2;
  if (brand === "AT" && format === "House Tour" && !has3FieldTitle) {
    format = "Compilation";
  }
  return { brand, format };
}

/* Split `<location> · <size> · <home_type>` into the three positioned fields.
   Auto-shrink ALL three to the same font size so they share a baseline (same
   behaviour as the Modal PIL renderer). */
function paintHouseTourFields() {
  const box = $("#picked-thumb-box");
  const containerH = box?.clientHeight || 0;
  if (!containerH) return;
  // 41pt @ 1920px canvas → scale to container.
  const basePx = (41 * containerH) / 1920;
  const minPx = (28 * containerH) / 1920;
  const title = (state.recipe.thumbnail_title || "").replace(/\r\n/g, "\n");
  const parts = title.split(/\s*·\s*/);
  while (parts.length < 3) parts.push("");
  const [loc, size, home] = parts;
  const setValue = (col, val) => {
    const el = $(`#overlay-ht-fields [data-col="${col}"]`);
    if (!el) return;
    el.textContent = val || "";
    el.style.fontSize = basePx + "px";
  };
  setValue("location", loc);
  setValue("size", size);
  setValue("home_type", home);
  // Shrink-to-fit: each field must not overflow its column width. Find the
  // largest size that works for all three (uniform sizing like Modal).
  let px = basePx;
  for (let attempt = 0; attempt < 8; attempt++) {
    const allEls = ["location", "size", "home_type"].map(c => $(`#overlay-ht-fields [data-col="${c}"]`));
    const overflow = allEls.some(el => el && el.scrollWidth > el.clientWidth + 1);
    if (!overflow || px <= minPx) break;
    px = Math.max(minPx, px - 2);
    allEls.forEach(el => { if (el) el.style.fontSize = px + "px"; });
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

  // Per-overlay font bounds + geometry — mirrors the production renderer.
  // Respects manual template override if set.
  const { brand: gb, format: gf } = activeOverlayBrandFormat();
  const geom = getOverlayGeom(gb, gf);
  const fontMin = geom.fontMin;
  const fontMax = geom.fontMax;

  // The pt sizes are relative to a 1920px-tall production canvas. Scale to box.
  const scaleToPx = pt => (pt * containerH) / 1920;

  let chosenPt = fontMin;
  let chosenLines = 99;

  for (let pt = fontMax; pt >= fontMin; pt -= FONT_STEP_PT) {
    titleEl.style.fontSize = scaleToPx(pt) + "px";
    const naturalH = titleEl.scrollHeight;
    const lineH = parseFloat(getComputedStyle(titleEl).lineHeight) || (scaleToPx(pt) * 1.05);
    const lines = Math.max(1, Math.round(naturalH / lineH));
    const fits = naturalH <= titleEl.clientHeight + 1 && lines <= 3;
    if (fits) {
      chosenPt = pt;
      chosenLines = lines;
      break;
    }
  }
  if (chosenLines === 99) {
    titleEl.style.fontSize = scaleToPx(fontMin) + "px";
    const naturalH = titleEl.scrollHeight;
    const lineH = parseFloat(getComputedStyle(titleEl).lineHeight) || (scaleToPx(fontMin) * 1.05);
    chosenLines = Math.max(1, Math.round(naturalH / lineH));
    chosenPt = fontMin;
  }
  $("#picked-overlay-meta").textContent = `${chosenPt}pt / ${chosenLines} ${chosenLines === 1 ? "line" : "lines"}`;
}

const fitOverlayDebounced = debounce(fitOverlayText, 60);
window.addEventListener("resize", fitOverlayDebounced);

/* ─────────────────────── Candidates ─────────────────────── */

async function loadCandidates(pid, token) {
  state.candidatesLoading = true;
  paintCandidates();
  let cands;
  try {
    const r = await api.candidates(state.year, pid);
    if (token !== undefined && token !== loadRowToken) return; // stale — user moved on
    cands = (Array.isArray(r) ? r : (r && r.candidates)) || [];
  } catch (e) {
    if (token !== undefined && token !== loadRowToken) return;
    console.error("candidates failed", e);
    state.candidatesLoading = false;
    $("#candidate-strip").innerHTML = `<div class="picker-empty">Failed to load candidates: ${escapeHtml(e.message || "")}</div>`;
    return;
  }
  state.candidatesLoading = false;
  state.candidates = cands;
  state.candidatesPid = pid;
  paintCandidates();
  PERF.mark("candidatesDone"); PERF.render();
}

// Partition state.candidates into:
//   cloud   — Cloudinary brand-curated thumbs (HIGHEST priority — editor-vetted)
//   frames  — Gemini-ranked picks (source="pro") OR raw extracted frames (source="frames")
// Flash + other extract folders are intentionally excluded.
// Default view shows all cloudinary (up to 6) + top 3 frames; "Show all" expands.
function partitionCandidates() {
  const cloud  = state.candidates.filter(c => c.source === "cloudinary");
  const frames = state.candidates.filter(c => c.source === "pro" || c.source === "frames");
  return { cloud, frames };
}

// Pick an evenly-spaced subset of N items from arr (deterministic, includes
// first + last when N >= 2). Used to show a "top picks" preview of raw frames
// instead of dumping all 60.
function evenlySpacedSample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const out = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

// Default preview count for frames in the candidate strip.
//   3 when no Codex picks are present (evenly-spaced sample).
//   When Codex picks land, those are used instead (primary + alt1 + alt2).
//   Cloudinary thumbs (curated by the editor) are always shown above this set,
//   so when both exist the visible count is ~3 cloud + 3 frames = ~6.
const FRAMES_PREVIEW_COUNT = 3;

function paintCandidates() {
  const strip = $("#candidate-strip");
  strip.innerHTML = "";
  const meta = $("#candidates-meta");
  if (state.candidatesLoading) {
    strip.innerHTML = `<div class="picker-empty picker-loading">
      <span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span>
      Fetching thumbnail candidates…
    </div>`;
    meta.textContent = "loading…";
    return;
  }
  if (!state.candidates.length) {
    strip.innerHTML = `<div class="picker-empty">No thumbnail candidates available for this row.</div>`;
    meta.textContent = "0 candidates";
    return;
  }
  const pickedFid = state.recipe.candidate_fid;
  const { cloud, frames } = partitionCandidates();

  // Render order (per Dan, 2026-05-13 — mirrors the old QC thumb tool):
  //   1. ALL Cloudinary thumbs (editor-curated; highest priority)
  //   2. Top frame picks — Codex pick_role primary/alt1/alt2 if present,
  //      otherwise an evenly-spaced sample of 3 frames
  //   3. "Show all N frames" button → expands remaining frames below

  // Identify the "top frames" set:
  //   * If Codex picks present, those are the top 3
  //   * Else evenly-spaced 3
  const codexPicks = frames.filter(f => f.pick_role).sort((a, b) => {
    const order = { primary: 0, alt1: 1, alt2: 2 };
    return (order[a.pick_role] ?? 9) - (order[b.pick_role] ?? 9);
  });
  let topFrames;
  if (codexPicks.length >= 1) {
    topFrames = codexPicks.slice(0, 3);
  } else {
    topFrames = evenlySpacedSample(frames, FRAMES_PREVIEW_COUNT);
  }
  // Always include the user's currently-picked candidate in the top section
  // so they see what's active without scrolling.
  if (pickedFid) {
    const pickedFrame = frames.find(f => f.file_id === pickedFid);
    if (pickedFrame && !topFrames.includes(pickedFrame)) {
      topFrames = [pickedFrame, ...topFrames.slice(0, 2)];
    }
  }

  const remainingFrames = frames.filter(f => !topFrames.includes(f));
  const isExpanded = !!state.candidatesFramesExpanded;
  // Auto-expand if the user already picked something hidden in the remaining set.
  if (!isExpanded && pickedFid && remainingFrames.some(f => f.file_id === pickedFid)) {
    state.candidatesFramesExpanded = true;
  }

  // Meta line.
  const cloudCount = cloud.length;
  const frameCount = frames.length;
  const parts = [];
  if (cloudCount) parts.push(`${cloudCount} Cloudinary`);
  if (frameCount) parts.push(`${frameCount} frames`);
  meta.textContent = parts.join(" · ");

  const renderOne = (c) => {
    const isPicked = c.file_id === pickedFid;
    const roleClass = c.pick_role ? " has-pick-role pick-" + c.pick_role : "";
    const elt = el("div", {
      class: "candidate" + (isPicked ? " picked" : "") + (c.source ? " src-" + c.source : "") + roleClass,
      dataset: { fid: c.file_id },
      onclick: () => onCandidateClick(c.file_id),
    });
    elt.append(el("img", { src: api.driveImageUrl(c.file_id, "candidate"), loading: "lazy", alt: "" }));
    if (isPicked) elt.append(el("div", { class: "badge-mini" }, "Picked"));
    // Codex pick role takes priority over source-based labels.
    if (c.pick_role === "primary") {
      elt.append(el("div", { class: "pick-label is-primary" }, "★ Primary"));
    } else if (c.pick_role === "alt1") {
      elt.append(el("div", { class: "pick-label is-alt" }, "Alt 1"));
    } else if (c.pick_role === "alt2") {
      elt.append(el("div", { class: "pick-label is-alt" }, "Alt 2"));
    } else if (c.source === "cloudinary") {
      elt.append(el("div", { class: "gemini-rank cloudinary-tag" }, "Cloudinary"));
    } else if (c.source === "pro" && c.gemini_rank != null) {
      elt.append(el("div", { class: "gemini-rank" }, `#${c.gemini_rank}`));
    } else if (c.source === "frames" && c.gemini_rank != null) {
      elt.append(el("div", { class: "gemini-rank frame-tag" }, `Frame ${c.gemini_rank}`));
    }
    return elt;
  };

  // 1. Cloudinary block (always visible up front)
  for (const c of cloud) strip.append(renderOne(c));
  // 2. Top frames block
  for (const c of topFrames) strip.append(renderOne(c));
  // 3. "Show all frames" / "Hide" toggle for the remaining frames
  if (remainingFrames.length) {
    if (!state.candidatesFramesExpanded) {
      const more = el("button", {
        class: "show-more-btn",
        onclick: () => { state.candidatesFramesExpanded = true; paintCandidates(); },
      }, `Show all ${frames.length} frames (+${remainingFrames.length})`);
      strip.append(more);
    } else {
      const sep = el("div", { class: "alts-sep" }, "All extracted frames");
      strip.append(sep);
      for (const c of remainingFrames) strip.append(renderOne(c));
    }
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
  // Save the draft only — no Modal render. The browser-side overlay preview
  // already shows the new candidate; the canonical Drive thumbnail render is
  // deferred until the title blurs (via saveDraftAndScheduleRender with
  // immediateRender:false → debounced) or until Approve fires the push step.
  api.saveDraft(state.year, state.selectedPid, state.recipe)
    .catch(e => console.warn("saveDraft (pick_candidate) failed:", e));
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
    toast(action === "unapprove" ? "Un-approved" : `${action[0].toUpperCase() + action.slice(1)}d`, "success");
    // Update local row + advance to next. Values match the worker's new Review Status enum.
    const r = state.rowIndex.get(state.selectedPid);
    if (r) {
      if (action === "approve")   { r.review_status = "JW APPROVED"; r.push_status = "Ready"; }
      if (action === "unapprove") { r.review_status = "";            r.push_status = ""; }
      if (action === "fix")       { r.review_status = "FIX";         r.push_status = `Hold: ${reason || "needs review"}`; }
      if (action === "exclude")   { r.review_status = "EXCLUDE";     r.push_status = "Excluded"; }
      paintRowList();
      paintFilterCounts();
      paintProgress();
    }
    if (state.currentRow) {
      if (action === "approve")   { state.currentRow.review_status = "JW APPROVED"; state.currentRow.push_status = "Ready"; }
      if (action === "unapprove") { state.currentRow.review_status = "";            state.currentRow.push_status = ""; }
      if (action === "fix")       { state.currentRow.review_status = "FIX";         state.currentRow.push_status = `Hold: ${reason || "needs review"}`; }
      if (action === "exclude")   { state.currentRow.review_status = "EXCLUDE";     state.currentRow.push_status = "Excluded"; }
    }
    paintApproveButton();
    // Auto-advance only after approve (not after un-approve — user is correcting a mistake).
    if (action === "approve") moveSelection(1);
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
      // input writes localStorage so tab-crash recovers; textarea also grows
      // to fit content (fallback for browsers without `field-sizing: content`).
      const isTextarea = elt.tagName === "TEXTAREA";
      elt.addEventListener("input", () => {
        persistLocalDraft();
        if (isTextarea) autoGrowTextarea(elt);
      });
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

  // Manual overlay template override.
  const overlaySel = $("#overlay-override");
  if (overlaySel) {
    overlaySel.addEventListener("change", () => {
      state.overlayOverride = overlaySel.value || "";
      paintOverlayPng();
      fitOverlayText();
    });
  }

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
        // Approve toggles: if already approved, send "unapprove"; else "approve".
        const r = state.rowIndex.get(state.selectedPid) || state.currentRow || {};
        const rs = (r.review_status || "").toUpperCase();
        const isApproved = (rs === "JW APPROVED" || rs === "APPROVED");
        doApproveAction(isApproved ? "unapprove" : "approve");
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
    // First-run path: boot() returns before reaching startPresenceLoop() when
    // settings are missing. Start it here so the count starts ticking on save.
    // Idempotent — no-ops if already running.
    startPresenceLoop();
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
  // Prefer row-number match (handles dup-pid). Fall back to pid for first nav
  // after page load when selectedRow isn't set yet.
  let idx = -1;
  if (state.selectedRow != null) {
    idx = rows.findIndex(r => r.row === state.selectedRow);
  }
  if (idx < 0) {
    idx = rows.findIndex(r => r.pid === state.selectedPid);
  }
  let next = idx + delta;
  if (next < 0) next = 0;
  if (next >= rows.length) next = rows.length - 1;
  const target = rows[next];
  if (target && target.row !== state.selectedRow) {
    state.selectedRow = target.row;
    navigate(rowPath(state.year, target.pid));
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
  // Presence: send a heartbeat + refresh the count immediately, then every 30s
  // while the tab is open. Worker TTL is 60s so 30s gives a 2× safety margin.
  startPresenceLoop();
}

const PRESENCE_BEAT_MS = 30000;
let _presenceTimer = null;
let _presenceTickSeq = 0;     // monotonic sequence; a stale tick is one whose
                              // seq < seqAtStart of any newer tick that finished first.
let _presenceLastApplied = 0; // highest seq that has applied a UI update.
async function presenceTick() {
  const seq = ++_presenceTickSeq;
  const name = (api.reviewer || "").trim();
  try {
    // Heartbeat first so our own entry is counted in the GET response.
    await api.presenceBeat(name);
    const { count } = await api.presenceList();
    // Drop stale results: if a newer tick has already updated the UI, ignore.
    if (seq < _presenceLastApplied) return;
    _presenceLastApplied = seq;
    const el = document.getElementById("presence-meta");
    const cn = document.getElementById("presence-count");
    if (el && cn) {
      cn.textContent = String(count);
      el.hidden = false;
    }
  } catch (e) {
    // Soft feature — never surface errors. Only hide the chip if THIS tick is
    // the latest; a later in-flight tick may still succeed and re-show it.
    if (seq < _presenceLastApplied) return;
    _presenceLastApplied = seq;
    const el = document.getElementById("presence-meta");
    if (el) el.hidden = true;
  }
}
function startPresenceLoop() {
  if (_presenceTimer) return;
  presenceTick();
  _presenceTimer = setInterval(presenceTick, PRESENCE_BEAT_MS);
  // Pause when the tab goes hidden — no point heartbeating an unattended tab.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (_presenceTimer) { clearInterval(_presenceTimer); _presenceTimer = null; }
    } else if (!_presenceTimer) {
      presenceTick();
      _presenceTimer = setInterval(presenceTick, PRESENCE_BEAT_MS);
    }
  });
}

// DOMContentLoaded has likely already fired (we're loaded dynamically with
// a cache-busting query string after body parse). If so, boot immediately.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
