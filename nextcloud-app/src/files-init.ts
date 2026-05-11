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
import { showError } from '@nextcloud/dialogs';
import AppIcon from '../img/app.svg?raw';
import { buildEmbedUrl, type IhubConfig } from './shared';

const APP_ID = 'ihub_chat';

function readConfig(): IhubConfig {
  return {
    baseUrl: String(loadState(APP_ID, 'baseUrl', '') || '').replace(/\/+$/, ''),
    providerId: String(loadState(APP_ID, 'providerId', 'nextcloud-main'))
  };
}

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

  const url = buildEmbedUrl(cfg.baseUrl, cfg.providerId, paths);
  if (!url) {
    showError(
      t(
        APP_ID,
        'iHub Chat could not open: the configured iHub base URL or provider id is invalid. Ask an administrator to check the values stored via `occ config:app:set ihub_chat …`.'
      )
    );
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
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
