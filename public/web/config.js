/*
 * Smart Mess manager dashboard - runtime configuration (Member 4).
 * Public, non-secret settings only. Never put passwords, tokens or database strings here.
 *
 *   apiBase       Backend (Member 2) origin. '' = same origin as this page.
 *   forecastBase  Origin that serves GET /api/forecasts. null = use apiBase. Do NOT point this at the raw ML
 *                 service: it needs a secret key that must never reach the browser. Use the backend route or
 *                 the local adapter (adapters/ml-proxy.js). Cross-origin calls need CORS for the exact app origin.
 *   messIds       Map "display name" -> id the backend expects, e.g. {'South Mess': 'south'}.
 *   refreshMs     Auto-refresh period for live counts (min 5000).
 *
 * Demo switch: opening the app as  http://localhost:3000/?demo=1  points the dashboard at the
 * SYNTHETIC mock API on http://localhost:4000 (start it with `npm run mock`). The mock is
 * not the real backend; every screen then shows a SYNTHETIC DATA banner.
 */
(function () {
  var cfg = { apiBase: '', forecastBase: null, messIds: {}, refreshMs: 30000, timeoutMs: 30000 };
  try {
    if (/[?&]demo=1(&|$)/.test(location.search)) { cfg.apiBase = 'http://localhost:4000'; cfg.demo = true; }
    // &mlproxy=1 sends forecast requests to the local ML adapter (npm run ml-proxy), which holds the ML key server-side.
    if (/[?&]mlproxy=1(&|$)/.test(location.search)) cfg.forecastBase = 'http://localhost:4100';
  } catch (e) { /* non-browser */ }
  window.SMART_MESS_CONFIG = cfg;
})();
