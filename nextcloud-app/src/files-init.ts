// Registers the "Chat with iHub" file action on the Nextcloud Files page.
// Targets @nextcloud/files v4 (the API shipped with Nextcloud 33). v4 uses
// plain `IFileAction` objects whose callbacks receive an `ActionContext`
// rather than positional args.

import {
  registerFileAction,
  Permission,
  FileType,
  type IFileAction,
  type ActionContext,
  type ActionContextSingle
} from '@nextcloud/files';
import { translate as t } from '@nextcloud/l10n';
import { loadState } from '@nextcloud/initial-state';
import { generateUrl } from '@nextcloud/router';
import { showError } from '@nextcloud/dialogs';
import AppIcon from '../img/app.svg?raw';
import { safeBaseUrl, type IhubConfig } from './shared';

const APP_ID = 'ihub_chat';
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

function readConfig(): IhubConfig {
  return {
    baseUrl: String(loadState(APP_ID, 'baseUrl', '') || '').replace(/\/+$/, ''),
    providerId: String(loadState(APP_ID, 'providerId', 'nextcloud-main'))
  };
}

// Validates the selection payload that gets forwarded through the URL hash
// (matching the rules in `buildEmbedUrl` in shared.ts) before we send users
// off to the ihub_chat host page. Centralising the validation here keeps the
// failure surface on the action itself instead of inside the iframe.
function buildHostPageHash(providerId: string, paths: string[]): string | null {
  if (!PROVIDER_ID_RE.test(providerId)) return null;
  if (!Array.isArray(paths)) return null;
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return null;
    if (p.indexOf('\0') !== -1) return null;
  }
  const params = new URLSearchParams();
  params.set('providerId', providerId);
  params.set('paths', JSON.stringify(paths));
  return params.toString();
}

// Open the iHub iframe **inside** Nextcloud by navigating to the app's own
// host page (/apps/ihub_chat/) with the selection in the URL hash. The host
// page (templates/main.php + src/main.ts) reads the hash, builds the iHub
// URL via shared.ts, and mounts the iframe — so the user stays in the
// Nextcloud chrome (top nav, sidebar) instead of jumping to a new tab.
function openEmbed(paths: string[]): void {
  const cfg = readConfig();
  if (!cfg.baseUrl) {
    showError(
      t(
        APP_ID,
        'iHub base URL is not configured. Ask an administrator to run: occ config:app:set ihub_chat ihub_base_url --value=https://ihub.example.com'
      )
    );
    return;
  }

  // Sanity-check the configured base URL up front so users get a clear
  // diagnostic from the file action, not a half-rendered iframe.
  if (!safeBaseUrl(cfg.baseUrl)) {
    showError(
      t(
        APP_ID,
        'iHub Chat could not open: the configured iHub base URL is invalid. Ask an administrator to check the value stored via `occ config:app:set ihub_chat ihub_base_url …`.'
      )
    );
    return;
  }

  const hash = buildHostPageHash(cfg.providerId, paths);
  if (hash === null) {
    showError(
      t(
        APP_ID,
        'iHub Chat could not open: the file selection or configured provider id is invalid.'
      )
    );
    return;
  }

  // `generateUrl` honours Nextcloud's webroot + index.php rewrite settings.
  const navUrl = generateUrl('/apps/{appId}/', { appId: APP_ID }) + '#' + hash;
  window.location.assign(navUrl);
}

const action: IFileAction = {
  id: 'ihub-chat',
  order: 50,
  displayName: () => t(APP_ID, 'Chat with iHub'),
  iconSvgInline: () => AppIcon,
  enabled: (ctx: ActionContext) =>
    ctx.view.id !== 'trashbin' &&
    ctx.nodes.length > 0 &&
    // Files only — chatting about a folder doesn't have a meaningful
    // semantics in iHub today.
    ctx.nodes.every(n => n.type === FileType.File) &&
    ctx.nodes.every(n => ((n.permissions ?? 0) & Permission.READ) !== 0),
  exec: async (ctx: ActionContextSingle) => {
    const p = ctx.nodes[0]?.path;
    if (!p) return null;
    openEmbed([p]);
    return null;
  },
  execBatch: async (ctx: ActionContext) => {
    const paths = ctx.nodes.map(n => n.path).filter((p): p is string => !!p);
    if (paths.length > 0) openEmbed(paths);
    return ctx.nodes.map(() => null);
  }
};

registerFileAction(action);
