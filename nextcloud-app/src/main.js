/* global OCA, OC */
/*
 * iHub Chat — Nextcloud Files plugin + iframe host bootstrap.
 *
 * Two concerns live in this bundle:
 *
 *   1. Register a "Chat with iHub" file action on the Nextcloud Files
 *      plugin registry. Clicking it navigates the user (in the same
 *      tab) to the iHub embed app page with the selected paths encoded
 *      in the URL hash.
 *
 *   2. On the iHub embed app page itself (templates/main.php), spawn
 *      the iframe to the iHub embed URL and forward subsequent
 *      selection changes via `postMessage`. The iHub-side bridge
 *      validates `event.origin` against its admin allowlist.
 *
 * Both concerns share the same payload shape so the iHub side does not
 * care which entry point a particular selection came from.
 */

(function () {
  'use strict';

  // ----- Shared helpers --------------------------------------------------

  // Provider ids in iHub's cloudStorage config are admin-controlled identifiers
  // (e.g. `nextcloud-main`). Restrict to a safe alphanumeric + dash/underscore
  // grammar so attacker-controlled values can't break out of the URL hash.
  var PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

  /**
   * Canonicalise the iHub base URL via the `URL` parser, which rejects
   * `javascript:` / `data:` / opaque-host inputs that would otherwise turn
   * an iframe `src` assignment into a script-execution vector. Returns a
   * trimmed `https?://host[:port]` origin or `null` if the input cannot
   * be safely used as an iframe target.
   */
  function safeBaseUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
    var u;
    try {
      u = new URL(raw);
    } catch (_e) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.origin;
  }

  /**
   * Build the iframe URL with the current selection encoded in the hash.
   * Returns `null` when any input fails validation; callers must check.
   *
   * @param {string} baseUrl     iHub origin (http[s]).
   * @param {string} providerId  iHub cloudStorage Nextcloud provider id.
   * @param {string[]} paths     Selected file paths.
   * @returns {string|null}
   */
  function buildEmbedUrl(baseUrl, providerId, paths) {
    var origin = safeBaseUrl(baseUrl);
    if (!origin) return null;
    if (typeof providerId !== 'string' || !PROVIDER_ID_RE.test(providerId)) return null;
    if (!Array.isArray(paths)) return null;
    var safePaths = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return null;
      if (p.indexOf('\0') !== -1) return null;
      safePaths.push(p);
    }
    var hash = new URLSearchParams();
    hash.set('providerId', providerId);
    hash.set('paths', JSON.stringify(safePaths));
    return origin + '/nextcloud/taskpane.html#' + hash.toString();
  }

  function readFilePathsFromContext(context) {
    // The Files plugin invokes the action handler once per click, but
    // `context.fileList.getSelectedFiles()` returns the full current
    // selection so users can multi-select before clicking.
    try {
      var selected = context.fileList.getSelectedFiles();
      if (selected && selected.length > 0) {
        return selected.map(function (f) {
          return joinPath(f.path, f.name);
        });
      }
    } catch (_e) {
      /* fall through */
    }
    // Fall back to the single file the action was bound to.
    return [joinPath(context.dir || '/', context.fileInfoModel.attributes.name)];
  }

  function joinPath(dir, name) {
    var d = String(dir || '').replace(/\/+$/, '');
    if (!d) d = '';
    return d + '/' + name;
  }

  function getAppConfig() {
    // Read the iHub base URL + provider id from the Files app config
    // injected by Nextcloud's `OCP\IConfig`. PageController writes both
    // values via `data-` attributes on `#ihub-chat-root`, but the file
    // action runs *before* that root mounts, so read from
    // `OC.appConfig` instead (which Nextcloud auto-injects).
    var cfg = (OC && OC.appConfig && OC.appConfig.ihub_chat) || {};
    return {
      baseUrl: String(cfg.ihub_base_url || '').replace(/\/+$/, ''),
      providerId: String(cfg.ihub_provider_id || 'nextcloud-main')
    };
  }

  // ----- File action registration ---------------------------------------

  function registerFileAction() {
    if (!OCA || !OCA.Files || !OCA.Files.fileActions) return;

    OCA.Files.fileActions.registerAction({
      name: 'IhubChat',
      displayName: t('ihub_chat', 'Chat with iHub'),
      mime: 'all',
      permissions: OC.PERMISSION_READ,
      iconClass: 'icon-comment',
      actionHandler: function (_fileName, context) {
        var cfg = getAppConfig();
        if (!cfg.baseUrl) {
          OC.dialogs.alert(
            t(
              'ihub_chat',
              'iHub base URL is not configured. Ask an administrator to run: occ config:app:set ihub_chat ihub_base_url --value=https://ihub.example.com'
            ),
            t('ihub_chat', 'iHub Chat')
          );
          return;
        }

        var paths = readFilePathsFromContext(context);
        if (!paths.length) return;

        var url = buildEmbedUrl(cfg.baseUrl, cfg.providerId, paths);
        if (!url) {
          OC.dialogs.alert(
            t(
              'ihub_chat',
              'iHub Chat could not open: the configured iHub base URL or provider id is invalid. Ask an administrator to check the values stored via `occ config:app:set ihub_chat ...`.'
            ),
            t('ihub_chat', 'iHub Chat')
          );
          return;
        }
        // Open in a new tab so the user doesn't lose their Nextcloud
        // Files context. The host page (templates/main.php) is mainly
        // useful as a Nextcloud navigation target; the file action path
        // is the primary flow.
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });
  }

  // ----- iframe host bootstrap (templates/main.php) ---------------------

  function bootstrapIframeHost() {
    var rootEl = document.getElementById('ihub-chat-root');
    if (!rootEl) return; // Not on the host page — skip.

    var rawBaseUrl = rootEl.getAttribute('data-ihub-base-url') || '';
    var rawProviderId = rootEl.getAttribute('data-ihub-provider-id') || 'nextcloud-main';
    if (!rawBaseUrl) {
      // PageController's template already renders a config-missing
      // message in this case; nothing to do.
      return;
    }

    // `buildEmbedUrl` returns null if either value fails validation; that's
    // also the right answer for the `targetOrigin` used below.
    var initialPaths = parsePathsFromHash() || [];
    var src = buildEmbedUrl(rawBaseUrl, rawProviderId, initialPaths);
    var targetOrigin = safeBaseUrl(rawBaseUrl);
    if (!src || !targetOrigin) {
      rootEl.textContent = t(
        'ihub_chat',
        'iHub Chat could not load: the configured iHub base URL or provider id is invalid.'
      );
      return;
    }

    var iframe = document.createElement('iframe');
    // Assigning `src` to a same-validated URL is safe — the URL has already
    // been parsed by `new URL()` (in `safeBaseUrl`) which rejects
    // `javascript:` / `data:` / opaque-host schemes.
    iframe.src = src;
    iframe.allow = 'clipboard-write';
    iframe.style.cssText = 'border:0;width:100%;height:100vh;min-height:600px;background:#fff;';
    rootEl.appendChild(iframe);

    // Subsequent selection changes — when the user picks files in Nextcloud
    // Files while the host page is open in another tab or pane — are
    // forwarded via postMessage. We use the iframe's origin as the
    // targetOrigin so we never broadcast to `*`.
    window.addEventListener('hashchange', function () {
      var paths = parsePathsFromHash();
      if (!paths) return;
      iframe.contentWindow.postMessage(
        {
          kind: 'ihub.nextcloud.selection',
          providerId: rawProviderId,
          paths: paths
        },
        targetOrigin
      );
    });
  }

  function parsePathsFromHash() {
    var raw = (window.location.hash || '').replace(/^#/, '');
    if (!raw) return null;
    var params;
    try {
      params = new URLSearchParams(raw);
    } catch (_e) {
      return null;
    }
    var json = params.get('paths');
    if (!json) return null;
    try {
      var arr = JSON.parse(json);
      if (!Array.isArray(arr)) return null;
      return arr.filter(function (s) {
        return typeof s === 'string' && s.length > 0;
      });
    } catch (_e) {
      return null;
    }
  }

  // ----- Entry points ----------------------------------------------------

  // The Nextcloud `app.js` bundle convention: register file actions when
  // OCA.Files is ready, and try to bootstrap the iframe host (no-op when
  // we're not on the host page).
  document.addEventListener('DOMContentLoaded', function () {
    bootstrapIframeHost();
  });

  if (OCA && OCA.Files && OCA.Files.fileActions) {
    registerFileAction();
  } else {
    document.addEventListener('DOMContentLoaded', registerFileAction);
  }
})();
