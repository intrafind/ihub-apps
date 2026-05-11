import { useEffect, useRef } from 'react';
import { apiClient } from '../../../api/client';
import { useEmbeddedHost } from '../../office/contexts/EmbeddedHostContext';
import { getCurrentSelection, onSelectionChange } from '../utilities/nextcloudSelectionBridge';
import { contentTypeFromExtension, fileNameFromPath } from '../utilities/nextcloudFileMeta';
import { NextcloudNotLinkedError } from '../utilities/nextcloudDocumentContext';
import { processCloudFile, isCloudFileSupported } from '../../upload/utils/cloudFileProcessing';

// Dedup state lives on `window`, not `sessionStorage`. Each click of
// "Chat with iHub" in Nextcloud reloads the host page (/apps/ihub_chat/),
// which destroys + recreates the iframe — so `window` (scoped to the iframe
// document) is fresh each time and the same selection re-attaches as
// expected. sessionStorage persists across iframe reloads in the same tab,
// which made re-clicking with the same file selection silently skip the
// attach.
//
// Within a single iframe instance the global survives React unmount/mount
// of AppChat, so app-switching inside iHub still respects "user already
// dealt with these files — don't re-attach."
const WINDOW_KEY = '__ihubNextcloudEmbedLastSig';
const RESET_EVENT = 'ihub:itemchanged';

function selectionSignature(selection) {
  if (!selection || !Array.isArray(selection.paths) || selection.paths.length === 0) return null;
  return `${selection.providerId}::${[...selection.paths].sort().join('|')}`;
}

function readLastSignature() {
  try {
    return window[WINDOW_KEY] || null;
  } catch {
    return null;
  }
}

function writeLastSignature(sig) {
  try {
    if (sig) window[WINDOW_KEY] = sig;
    else delete window[WINDOW_KEY];
  } catch {
    /* benign */
  }
}

function makeLoadingPlaceholder(path) {
  const name = fileNameFromPath(path);
  return {
    type: 'document',
    source: 'nextcloud',
    fileName: name,
    fileSize: 0,
    fileType: contentTypeFromExtension(name),
    loading: true,
    filePath: path
  };
}

async function downloadAsFile(path) {
  const response = await apiClient.get('/integrations/nextcloud/download', {
    params: { filePath: path },
    responseType: 'blob'
  });
  const blob = response.data;
  const name = fileNameFromPath(path);
  const contentType = contentTypeFromExtension(name);
  return new File([blob], name, { type: contentType });
}

/**
 * Auto-attaches files the user selected in Nextcloud (forwarded via the
 * embed hash / postMessage bridge) into the chat's file uploader.
 *
 * No-op unless mounted inside the Nextcloud full-app embed
 * (`useEmbeddedHost().kind === 'nextcloud'`). Re-attaches when the
 * selection signature changes — switching apps with the same selection
 * is a no-op so user-removed files stay removed. A `ihub:itemchanged`
 * DOM event (dispatched by `client/nextcloud/full-app-entry.jsx` on every
 * bridge update) resets the dedup signature, so a fresh Nextcloud
 * selection always re-attaches.
 *
 * Effect deps are stable identifiers (`app?.id`, `currentModel?.id`,
 * `host?.kind`) — the file upload handler and full app/model objects are
 * read through a ref to avoid tearing down in-flight downloads when the
 * caller re-renders.
 *
 * @param {object} fileUploadHandler - returned by `useFileUploadHandler()`
 * @param {object} app - current app config
 * @param {object} currentModel - resolved model object (id, supportsVision, etc.)
 */
export function useNextcloudEmbedAttachments(fileUploadHandler, app, currentModel) {
  const host = useEmbeddedHost();
  const liveRef = useRef({ fileUploadHandler, app, currentModel });
  liveRef.current = { fileUploadHandler, app, currentModel };

  const hostKind = host?.kind;
  const appId = app?.id;

  // Effect deps intentionally exclude `currentModel?.id`. The model is read
  // through `liveRef.current.currentModel` at attach() time, so the upload
  // config still picks up the latest model. Including modelId in deps caused
  // the effect to re-run when models loaded after AppChat mount, which
  // cancelled the in-flight download and stuck the placeholder UI on
  // `loading: true`.
  useEffect(() => {
    if (hostKind !== 'nextcloud') return undefined;
    if (!appId) return undefined;

    const cancel = { cancelled: false };

    async function attach(selection) {
      if (cancel.cancelled) return;
      const sig = selectionSignature(selection);
      if (!sig) return;
      if (sig === readLastSignature()) return;

      const { fileUploadHandler: fuh, app: currentApp, currentModel: model } = liveRef.current;
      if (!fuh || !currentApp) return;

      const uploadConfig = fuh.createUploadConfig(currentApp, model);
      if (!uploadConfig || uploadConfig.enabled === false) {
        console.warn(
          '[nextcloud-embed] App does not allow uploads; skipping auto-attach of',
          selection.paths
        );
        return;
      }

      const supported = Array.isArray(uploadConfig.supportedFormats)
        ? uploadConfig.supportedFormats
        : null;

      const eligiblePaths = selection.paths.filter(path => {
        const name = fileNameFromPath(path);
        const ct = contentTypeFromExtension(name);
        if (!isCloudFileSupported(ct) && ct !== 'application/octet-stream') {
          // Pass user-controlled values as separate args (not interpolated into the
          // format string) so they can't influence `%s`/`%d` substitution.
          console.warn(
            '[nextcloud-embed] Unsupported file type; skipping. path=%s contentType=%s',
            path,
            ct
          );
          return false;
        }
        if (
          supported &&
          supported.length > 0 &&
          ct !== 'application/octet-stream' &&
          !supported.includes(ct)
        ) {
          console.warn(
            '[nextcloud-embed] App does not allow this content type; skipping. contentType=%s path=%s',
            ct,
            path
          );
          return false;
        }
        return true;
      });

      if (eligiblePaths.length === 0) {
        console.warn('[nextcloud-embed] No eligible files in selection');
        return;
      }

      // NOTE: we do NOT writeLastSignature(sig) before the downloads complete.
      // If we did, an effect re-run (e.g. modelId transitioning from undefined
      // to a value after the models endpoint resolves) would cancel the
      // in-flight downloads via `cancel.cancelled`, and the next attach() call
      // would see the sig in sessionStorage and return early — leaving the
      // placeholders with `loading: true` stuck in state forever.

      const working = eligiblePaths.map(makeLoadingPlaceholder);
      fuh.setSelectedFile(working.length === 1 ? working[0] : working);

      for (let i = 0; i < eligiblePaths.length; i += 1) {
        if (cancel.cancelled) return;
        const path = eligiblePaths[i];
        try {
          const file = await downloadAsFile(path);
          const processed = await processCloudFile(file, uploadConfig);
          working[i] = {
            ...processed,
            source: 'nextcloud',
            providerId: selection.providerId,
            filePath: path
          };
        } catch (err) {
          if (err instanceof NextcloudNotLinkedError) {
            console.warn(
              '[nextcloud-embed] Nextcloud not linked to iHub user; aborting auto-attach. Use the cloud-storage picker to connect.'
            );
            if (!cancel.cancelled) {
              fuh.clearSelectedFile();
            }
            return;
          }
          // Pass user-controlled `path` as a separate arg (not interpolated into the
          // format string) so it can't influence `%s`/`%d` substitution.
          console.warn('[nextcloud-embed] Failed to download. path=%s error=', path, err);
          working[i] = { ...working[i], loading: false, error: true };
        }

        if (cancel.cancelled) return;
        const display = working.filter(f => !f.error);
        if (display.length === 0) {
          fuh.clearSelectedFile();
        } else {
          fuh.setSelectedFile(display.length === 1 ? display[0] : display);
        }
      }

      // All downloads finished without being cancelled — commit the dedup
      // signature so a re-mount of AppChat with the same selection doesn't
      // re-attach (and re-trigger placeholders).
      if (!cancel.cancelled) {
        writeLastSignature(sig);
      }
    }

    attach(getCurrentSelection());
    const unsubscribe = onSelectionChange(attach);

    function handleReset() {
      writeLastSignature(null);
    }
    document.addEventListener(RESET_EVENT, handleReset);

    return () => {
      cancel.cancelled = true;
      unsubscribe();
      document.removeEventListener(RESET_EVENT, handleReset);
    };
  }, [hostKind, appId]);
}

export default useNextcloudEmbedAttachments;
