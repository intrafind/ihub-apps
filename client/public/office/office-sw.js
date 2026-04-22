/* global self, caches, fetch, Response */

/**
 * iHub Office Add-in Service Worker
 *
 * Provides offline resilience for the Outlook taskpane when the iHub server
 * is unreachable. Strategy: network-first with cache fallback for /office/* requests.
 *
 * Critical: Outlook appends ?_host_Info=... query strings to the taskpane URL.
 * All cache lookups use { ignoreSearch: true } to match regardless of query params.
 */

const CACHE_NAME = 'ihub-office-v1';

// Minimal bilingual offline fallback page served when both network and cache are unavailable.
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>iHub Apps</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 32px 24px;
      max-width: 320px;
      width: 100%;
      text-align: center;
    }
    .icon { color: #94a3b8; margin-bottom: 16px; }
    h1 { font-size: 1.1rem; font-weight: 600; color: #1e293b; margin-bottom: 8px; }
    p { font-size: 0.875rem; color: #64748b; line-height: 1.5; margin-bottom: 24px; }
    button {
      background: #3b82f6;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px 24px;
      font-size: 0.875rem;
      font-family: inherit;
      cursor: pointer;
      width: 100%;
    }
    button:hover { background: #2563eb; }
    [lang] { display: none; }
  </style>
  <script>
    var lang = (navigator.language || 'en').split('-')[0].toLowerCase();
    document.addEventListener('DOMContentLoaded', function() {
      var els = document.querySelectorAll('[lang]');
      for (var i = 0; i < els.length; i++) {
        els[i].style.display = els[i].getAttribute('lang') === lang ? '' : 'none';
      }
      // Fallback to English if no match found
      var visible = document.querySelector('[lang]:not([style*="none"])');
      if (!visible) {
        var enEls = document.querySelectorAll('[lang="en"]');
        for (var j = 0; j < enEls.length; j++) enEls[j].style.display = '';
      }
    });
  </script>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
        <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
        <line x1="12" y1="20" x2="12.01" y2="20"/>
      </svg>
    </div>
    <h1 lang="en">Server Not Reachable</h1>
    <h1 lang="de">Server nicht erreichbar</h1>
    <p lang="en">Please check your network connection and try again.</p>
    <p lang="de">Bitte überprüfen Sie Ihre Netzwerkverbindung und versuchen Sie es erneut.</p>
    <button lang="en" onclick="location.reload()">Retry</button>
    <button lang="de" onclick="location.reload()">Erneut versuchen</button>
  </div>
</body>
</html>`;

// Install: skip waiting so the new SW activates immediately.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

// Activate: claim all clients and prune old ihub-office-v* caches.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith('ihub-office-') && key !== CACHE_NAME)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first with cache fallback for same-origin /office/* GET requests.
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests.
  if (request.method !== 'GET') return;

  // Only handle same-origin requests under /office/.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Normalize the path to strip any subpath prefix, then check for /office/.
  if (!url.pathname.includes('/office/')) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        // Cache successful HTML/JS/CSS responses.
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            // Store keyed by pathname only so ignoreSearch lookups work.
            cache.put(url.pathname, clone);
          });
        }
        return response;
      })
      .catch(() =>
        // Network failed — try cache, ignoring any query string Outlook may have appended.
        caches.match(request, { ignoreSearch: true }).then(
          cached =>
            cached ||
            new Response(OFFLINE_HTML, {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            })
        )
      )
  );
});
