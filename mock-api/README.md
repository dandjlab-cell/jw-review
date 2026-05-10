# mock-api/ — local-dev fixtures

These JSON files let you exercise the UI layout without a live Worker. Set Worker URL = `./mock-api` (or `http://localhost:8000/mock-api`) on first load.

The mock API only covers GET endpoints that the viewer needs to paint:

- `GET /api/rows?year=2026...` → maps to `rows.json`
- `GET /api/rows/2026/2603K016` → maps to `row_2603K016.json`
- `GET /api/candidates/2026/2603K016` → maps to `candidates_2603K016.json`

Saving paths (PATCH/POST) won't work — those need a real Worker.

The **static-server fallback** is best-effort: a real client like `python3 -m http.server` will return `rows.json` for any `?year=...` query (the path before the `?` is what matches), but a path like `/api/rows/2026/2603K016` looks like a directory, so we use a small URL-rewriting trick: the app talks to URLs of the form `${workerUrl}/path`, and when `workerUrl=./mock-api`, you fetch `./mock-api/api/rows/2026/2603K016` — so create matching files like `mock-api/api/rows/2026/2603K016.json` and configure your dev server to serve `.json` for paths without an extension.

Easier: serve via Node + http-server with `--push-state` style handler. Or use a tiny Python wrapper:

```bash
# from jw-review/
python3 -m http.server 8000
```

Then in browser: open http://localhost:8000/, click ⚙, set Worker URL to a real Worker. The mock-api dir is mostly for inspecting JSON shapes by hand.
