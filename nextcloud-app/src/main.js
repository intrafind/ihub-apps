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

  /**
   * Build the iframe URL with the current selection encoded in the hash.
   * @param {string} baseUrl     Trimmed iHub origin (no trailing slash).
   * @param {string} providerId  iHub cloudStorage Nextcloud provider id.
   * @param {string[]} paths     Selected file paths.
   */
  function buildEmbedUrl(baseUrl, providerId, paths) {
    var hash = new URLSearchParams();
    hash.set('providerId', providerId);
    hash.set('paths', JSON.stringify(paths));
    return baseUrl + '/nextcloud/taskpane.html#' + hash.toString();
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

    var baseUrl = rootEl.getAttribute('data-ihub-base-url') || '';
    var providerId = rootEl.getAttribute('data-ihub-provider-id') || 'nextcloud-main';
    if (!baseUrl) {
      // PageController's template already renders a config-missing
      // message in this case; nothing to do.
      return;
    }

    var initialPaths = parsePathsFromHash() || [];
    var iframe = document.createElement('iframe');
    iframe.src = buildEmbedUrl(baseUrl, providerId, initialPaths);
    iframe.allow = 'clipboard-write';
    iframe.style.cssText = 'border:0;width:100%;height:100vh;min-height:600px;background:#fff;';
    rootEl.appendChild(iframe);

    // Subsequent selection changes — when the user picks files in
    // Nextcloud Files while the host page is open in another tab or
    // pane — are forwarded via postMessage. We use the iframe's
    // origin as the targetOrigin so we never broadcast to `*`.
    var targetOrigin;
    try {
      targetOrigin = new URL(baseUrl).origin;
    } catch (_e) {
      targetOrigin = null;
    }

    if (targetOrigin) {
      window.addEventListener('hashchange', function () {
        var paths = parsePathsFromHash();
        if (!paths) return;
        iframe.contentWindow.postMessage(
          {
            kind: 'ihub.nextcloud.selection',
            providerId: providerId,
            paths: paths
          },
          targetOrigin
        );
      });
    }
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
