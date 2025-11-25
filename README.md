# Travel Planner Observer (frontend)

React dashboard to monitor, in real time, which HTTP methods and paths are being hit on the Travel Planner API (`https://leiame.app`) by matrícula. It gates access with the admin token, tries a WebSocket connection for live events, and falls back to HTTP polling of `/reports/usage` if the socket is unavailable.

## Quickstart
1) Install dependencies: `npm install`  
2) Start dev server: `npm run dev` (Vite)  
3) Open the UI and enter:
   - Admin token (required): the same `ADMIN_TOKEN` configured in the API.
   - API base: defaults to `https://leiame.app`.
   - WebSocket path: defaults to `/reports/usage/stream` (edit if your backend exposes a different path).

The login validates the token against `/reports/usage` (admin-only) and stores it locally for convenience. The token is sent as `Authorization` for HTTP calls and as a query param on the WebSocket URL (`?adminToken=...`), plus optional `matricula` filtering.

## What the dashboard shows
- Live tail of usage logs (method, path, matricula, status, timestamp), capped at 400 events.
- Aggregation by method (GET/POST/PUT/PATCH/DELETE) and by the exercise flows from `exercise-instructions-plain-pt-br.md` (clients, hotels, planes, offers, purchases, reviews, itineraries, reports).
- Matricula scope: optional 7-digit filter sent to the backend to reduce noise; local text filter for path/method search.
- Connection state badge: WebSocket → HTTP polling fallback if the socket cannot be established.

## Deploy to GitHub Pages
The Vite `base` is set to `/travel-planner-panel/` for GitHub Pages. To publish:
```bash
npm run build
npm run deploy  # pushes dist/ to the gh-pages branch via gh-pages
```
Ensure the repository is linked to GitHub and Pages is configured to serve from the `gh-pages` branch.

## Notes
- The production API allows CORS. If the WebSocket path is not available on your deployment, the UI automatically keeps polling `/reports/usage` every few seconds.
- To change the defaults permanently, edit `DEFAULT_HTTP_BASE`/`DEFAULT_WS_PATH` in `src/App.tsx`. The UI also allows overriding them at login time.
