// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchChatArtifact } from '../../../api';
import { openExternalUrl } from '../../../utils/externalNavigation';
import { useArtifactFetcher } from '../contexts/ArtifactFetchContext';
import ArtifactViewerContext from '../contexts/ArtifactViewerContext';
import { blobOfBase64, collectOpenableArtifacts, isLiveArtifact } from '../utils/artifactFiles';
import ArtifactViewer from './ArtifactViewer';

/** Name of the search parameter that records the open artifact in the chat URL. */
export const ARTIFACT_PARAM = 'artifact';

/**
 * Owns the immersive viewer of a chat page and offers `openArtifact` to
 * everything below it (the message cards, the Files drawer).
 *
 * The open artifact is mirrored into the URL as `?artifact=<id>` (stored
 * artifacts only; a live-turn file has no id the server knows): reloading or
 * copying the URL reopens it, and the browser's Back button closes it.
 *
 * @param {Object} props
 * @param {import('react').ReactNode} props.children
 * @param {Object[]} [props.messages] - The conversation: which artifacts the viewer steps through.
 * @param {string} [props.chatId] - Owner's chat the stored artifacts belong to.
 * @param {(artifact: Object) => Promise<Blob>} [props.fetchBlob] - Bytes of a stored artifact; by
 *   default the owner's route (or the fetcher an `ArtifactFetchContext` supplies).
 * @param {(artifact: Object) => void} [props.onShare] - Adds Share to the viewer.
 * @param {(artifact: Object) => void} [props.onShowInFiles] - Adds "Show in files".
 * @param {(artifact: Object) => string|null} [props.newTabUrl] - Route of a standalone page for an
 *   artifact; adds "Open in new tab" when it returns a URL.
 * @param {boolean} [props.splitAvailable] - A chat sits behind the viewer: offer the "Chat" toggle.
 */
export default function ArtifactViewerHost({
  children,
  messages,
  chatId,
  fetchBlob = null,
  onShare = null,
  onShowInFiles = null,
  newTabUrl = null,
  splitAvailable = false
}) {
  const customFetch = useArtifactFetcher();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const paramId = searchParams.get(ARTIFACT_PARAM);
  const [opened, setOpened] = useState(null);
  const [siblings, setSiblings] = useState(null);
  // Whether this host added the history entry the viewer's URL sits on.
  const pushedRef = useRef(false);

  const collected = useMemo(() => collectOpenableArtifacts(messages), [messages]);

  // URL → viewer: a reload, a pasted link, Back and Forward.
  useEffect(() => {
    if (!paramId) {
      setOpened(current => (current && !isLiveArtifact(current) ? null : current));
      pushedRef.current = false;
      return;
    }
    setOpened(current => {
      if (current?.id === paramId) return current;
      return collected.find(item => item.id === paramId) || current;
    });
  }, [paramId, collected]);

  const writeParam = useCallback(
    (id, replace) =>
      setSearchParams(
        previous => {
          const next = new URLSearchParams(previous);
          if (id) next.set(ARTIFACT_PARAM, id);
          else next.delete(ARTIFACT_PARAM);
          return next;
        },
        { replace }
      ),
    [setSearchParams]
  );

  const openArtifact = useCallback(
    (given, list) => {
      if (!given) return;
      // A live picture has no id yet: give it the key the chat's list knows it by.
      const artifact = given.id
        ? given
        : collected.find(item => item.data && item.data === given.data) || {
            ...given,
            id: `live:open:${Date.now()}`
          };
      setOpened(artifact);
      setSiblings(Array.isArray(list) ? list : null);
      if (!isLiveArtifact(artifact)) {
        pushedRef.current = !paramId;
        writeParam(artifact.id, Boolean(paramId));
      }
    },
    [paramId, writeParam, collected]
  );

  const close = useCallback(() => {
    const wasStored = opened && !isLiveArtifact(opened);
    setOpened(null);
    setSiblings(null);
    if (wasStored && paramId) {
      // Undo the entry this host pushed so Back does not reopen the viewer;
      // a deep link has no earlier entry of ours, so just drop the parameter.
      if (pushedRef.current) navigate(-1);
      else writeParam(null, true);
      pushedRef.current = false;
    }
  }, [opened, paramId, navigate, writeParam]);

  const select = useCallback(
    artifact => {
      setOpened(artifact);
      if (!isLiveArtifact(artifact)) writeParam(artifact.id, true);
    },
    [writeParam]
  );

  const getBlob = useCallback(
    artifact => {
      if (artifact.data) return Promise.resolve(blobOfBase64(artifact.data, artifact.mimeType));
      if (fetchBlob) return fetchBlob(artifact);
      return (customFetch || fetchChatArtifact)(chatId, artifact.id);
    },
    [fetchBlob, customFetch, chatId]
  );

  const context = useMemo(() => ({ openArtifact }), [openArtifact]);
  const list = siblings || collected;
  const url = opened && newTabUrl && !isLiveArtifact(opened) ? newTabUrl(opened) : null;

  return (
    <ArtifactViewerContext.Provider value={context}>
      {children}
      {opened && (
        <ArtifactViewer
          artifact={opened}
          artifacts={list}
          onSelect={select}
          onClose={close}
          getBlob={getBlob}
          onShare={onShare && !isLiveArtifact(opened) ? onShare : null}
          onShowInFiles={
            onShowInFiles && !isLiveArtifact(opened)
              ? artifact => {
                  close();
                  onShowInFiles(artifact);
                }
              : null
          }
          onOpenInNewTab={
            url
              ? async () => {
                  // Loaded on demand: the base path is only needed here.
                  const { buildPath } = await import('../../../utils/runtimeBasePath');
                  openExternalUrl(new URL(buildPath(url), window.location.origin).href);
                }
              : null
          }
          splitAvailable={splitAvailable}
        />
      )}
    </ArtifactViewerContext.Provider>
  );
}
