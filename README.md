# JW Review UX

Per-video review tool for the AT/Kitchn JW archive (`JW Seed 2026 (UX Test)` and future year tabs). A static frontend that talks to a Cloudflare Worker which fronts Google Sheets, Drive, and a Modal pixel-perfect renderer.

This repo is **frontend only**. The Worker is a separate repo.

## What this is

- Replaces 27-column horizontal-scroll-Sheets review with a focused per-video review page.
- Single HTML page, single CSS file, single vanilla JS file. **No build step.** Just open `index.html`.
- Mirrors the design/deploy pattern of [`at-thumb-qc`](https://dandjlab-cell.github.io/at-thumb-qc/).
- Architecture spec: see `PLAN.md` in the original mockups folder (locked decisions D1-D14, save model, fallback chain, etc.).
- Deploys to GitHub Pages.

## Local dev

```bash
cd /Users/dandj/DevApps/jw-review
# any static server works:
python3 -m http.server 8000
# or:
npx http-server -p 8000
```

Then open `http://localhost:8000`.

### First-load prompts

On first visit (or after clicking the gear icon in the top bar), the app prompts for three things:

| key | localStorage key | sent as |
|---|---|---|
| Reviewer name | `jw-reviewer` | `X-JW-User` request header |
| Worker URL | `jw-worker-url` | base for all `/api/*` calls |
| Shared secret token | `jw-token` | `X-JW-Token` request header |

All three are stored in `localStorage` and reused on subsequent loads. Click the gear icon (top-right) to change them.

For local dev without a live Worker, set Worker URL to `./mock-api` and the included `mock-api/` JSON files give you enough fixtures to exercise the layout. The mock route is best-effort — it covers `GET /api/rows`, `GET /api/rows/:y/:p`, and `GET /api/candidates/:y/:p`. Editing/saving paths will fail (expected) until you point at a real Worker.

## Routes (hash-based)

| URL | View |
|---|---|
| `index.html` (no hash) | redirects to `#/2026` |
| `#/<year>` | list view (default first row in detail) |
| `#/<year>/<project_number>` | single-row review (deep-linkable) |
| `#/<year>?status=Ready&brand=Kitchn&format=Recipe` | filtered list (query after `?` in hash) |
| `#/<year>/_history` | global activity feed (Phase 6 — placeholder for now) |

Hash-based for GitHub Pages compatibility (no server rewrites needed). Listens to `hashchange`. The spec calls out either pushState or hash routing — we picked hash because every URL works on a static host without 404 acrobatics.

## Worker API contract

All requests include:
- `X-JW-Token: <shared-secret>` (auth)
- `X-JW-User: <reviewer-name>` (audit log)

```
GET  /health
GET  /api/rows?year=2026&status=Ready&brand=Kitchn&format=Recipe
GET  /api/rows/:year/:pid                 → row + bootstrap-resolved candidate_fid
PATCH /api/rows/:year/:pid                body: { field: value }
GET  /api/candidates/:year/:pid           → [{ file_id, gemini_rank, gemini_score }]
GET  /api/drive-image/:fileId?role=hero|candidate|thumbnail
POST /api/draft/:year/:pid                body: { recipe }
POST /api/render/:year/:pid               triggers Modal pixel-perfect render
POST /api/render-fallback/:year/:pid      body: blob (browser canvas fallback)
GET  /api/history/:year/:pid              per-video history
GET  /api/history/:year                   global activity feed
POST /api/restore/:year/:pid              body: { history_id }
POST /api/approve/:year/:pid              body: { action: "approve"|"fix"|"exclude", reason? }
```

## Save model (two-tier — see PLAN §5)

- **Tier 1** (cheap, frequent): localStorage write → PATCH sheet (debounced 500ms on text blur, immediate on dropdown change) → POST `/api/draft` → KV + `_review_history` row.
- **Tier 2** (expensive, less frequent): POST `/api/render` → Modal pixel-perfect render → Drive update. Triggered by candidate pick (immediate), explicit Save, or 5s idle after the last meaningful Tier 1 change.
- **Modal failure** → browser canvas fallback re-renders the same recipe and POSTs to `/api/render-fallback`. UX shows a `⚡ approximate` badge; the auto-recovery sweep (Phase 8) silently re-renders later when Modal recovers.

## Status pip states (top-right corner of picked thumbnail)

| Pip | Meaning |
|---|---|
| ● saved | Recipe in KV + render in Drive, pixel-perfect |
| ◐ saving | Tier 1 done, Tier 2 in flight |
| ⚡ approximate | Canvas-rendered fallback (Modal was down) |
| ⚠ retrying | Last save failed, browser is retrying |
| ✕ offline | Network down, edits queued in localStorage |

## Keyboard shortcuts

| Key | Action |
|---|---|
| J / ↓ | Next row |
| K / ↑ | Prev row |
| A | Approve current row |
| X | Exclude current row |
| / | Focus the search field |
| ? | Show help (toggles a hint overlay) |
| Esc | Close any open panel/dialog |

## Live overlay preview (browser canvas)

The picked thumbnail is composed in the browser:

1. Hero JPG (background)
2. Static overlay PNG (`assets/overlays/<brand>_<format>_overlay.png`)
3. Title text positioned per `dispatch_recipes.py` constants:
   - Horizontal: 12.7%–87.3%
   - Vertical: 82.4%–92.3% (1-2 line case)
   - Font: DomaineText-Bold, auto-shrunk in a 76→56pt loop (step 2pt) to find the largest size that fits

A small badge on the picked thumbnail shows `<ptsize>pt / <lineCount> lines` for debug. Canvas preview is best-effort — the canonical render is the Modal output saved to Drive.

**Format coverage:**

| Brand | Format | Live preview overlay |
|---|---|---|
| Kitchn | Recipe | ✅ `kitchn_recipe_overlay.png` |
| Kitchn | Compilation | ✅ same template |
| AT | Compilation | ✅ `at_ht_compilation_overlay.png` |
| AT | House Tour | ❌ "live preview unavailable" badge (Illustrator-rendered in production) |
| AT | How To | ❌ same |

## Deploy to GitHub Pages

Mirror of the `at-thumb-qc` deploy pattern.

```bash
cd /Users/dandj/DevApps/jw-review
git init
git add .
git commit -m "Initial scaffold"
# Create a new repo on GitHub, then:
git remote add origin git@github.com:<owner>/jw-review.git
git branch -M main
git push -u origin main
```

Then in the GitHub repo:

1. Settings → Pages → Source: `Deploy from a branch`
2. Branch: `main`, folder: `/ (root)`
3. Wait ~30s; the page will be live at `https://<owner>.github.io/jw-review/`

After every push to `main`, GitHub re-deploys automatically.

## File tree

```
jw-review/
├── README.md
├── index.html              # entry; loads styles.css + app.js
├── styles.css              # ports approach-5-hybrid.html + _shared.css
├── app.js                  # vanilla JS (~1000 lines)
├── assets/
│   ├── overlays/
│   │   ├── kitchn_recipe_overlay.png
│   │   └── at_ht_compilation_overlay.png
│   └── fonts/
│       └── DomaineText-Bold.woff2     ← see "Font conversion TODO" below
├── mock-api/                          # local-dev fixtures (optional)
│   ├── rows.json
│   ├── row_2603K016.json
│   └── candidates_2603K016.json
└── .gitignore
```

## Font conversion TODO

The font was NOT auto-converted during scaffolding (the source `~/Library/Fonts/DomaineText-Bold.otf` was outside the writable sandbox at scaffold time). Convert it manually before opening the page, otherwise the live overlay preview will fall back to Charter / Iowan Old Style.

```bash
# fonttools (already installed at ~/Library/Python/3.9/bin/pyftsubset on Dan's machine):
pyftsubset ~/Library/Fonts/DomaineText-Bold.otf \
  --output-file=/Users/dandj/DevApps/jw-review/assets/fonts/DomaineText-Bold.woff2 \
  --flavor=woff2 \
  --unicodes='U+0000-00FF,U+2000-206F' \
  --layout-features='*'
```

If `pyftsubset` is missing, install with `pip install fonttools brotli` first.

Alternatively, `brew install woff2 && woff2_compress ~/Library/Fonts/DomaineText-Bold.otf` (output goes to the same dir as the input; copy to `assets/fonts/`).

If conversion is still failing, drop the .otf into `assets/fonts/` directly and update the `@font-face` `src` line in `styles.css` from `.woff2` to `.otf`. It works, just larger over the wire.

## What this UX does NOT do

- Does NOT invoke `jw_push_2026.py`. Approve writes Push Status; Dan/cron runs the script.
- Does NOT replace the Python batch dispatcher. Modal wraps the same renderer.
- Does NOT touch the live `JW Seed 2026` tab — the Worker enforces the D14 guard server-side. This UX targets `JW Seed 2026 (UX Test)` and future year tabs.

## Open questions / unresolved

- **DomaineText-Bold.woff2 not auto-generated.** Requires manual conversion; see TODO above.
- **mock-api fixtures are minimal.** They cover viewer-paint cases only. Saving paths require a real Worker.
- **Drive image proxying.** All image fetches go through `${WORKER_URL}/api/drive-image/<fid>?role=…`. If WORKER_URL is misconfigured, every image will 404 — the UI shows a clear empty state per image.
- **Global activity feed (`/<year>/_history`).** Placeholder route only; full implementation is Phase 6 in PLAN.md.
- **Hover-zoom on candidate strip thumbnails.** Marked as nice-to-have in the spec; deferred until reviewers ask for it.
