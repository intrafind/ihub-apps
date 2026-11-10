// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchChatArtifact } from '../../../api';
import Icon from '../../../shared/components/Icon';
import SkipLink from '../../../shared/components/SkipLink';
import useMediaQuery from '../../../shared/hooks/useMediaQuery';
import { GHOST_BUTTON } from '../../../shared/utils/buttonTokens';
import { openExternalUrl } from '../../../utils/externalNavigation';
import { useEmbeddedHostKind } from '../../office/contexts/EmbeddedHostContext';
import WorkspacePane from '../../workspace/components/WorkspacePane';
import WorkspaceLayoutContext from '../../workspace/contexts/WorkspaceLayoutContext';
import useWorkspaceLists from '../../workspace/hooks/useWorkspaceLists';
import { collectCitedSources, revealMessage } from '../../workspace/utils/workspaceItems';
import {
  PANE_PARAMS,
  SPLIT_MIN_VIEWPORT,
  WORKSPACE_PANE_EVENT,
  clampPaneWidth,
  defaultPaneWidth,
  escapeLayer,
  presentationOf,
  readPaneParams,
  readStoredWidth,
  sameTarget,
  widthPercent,
  writePaneParams,
  writeStoredWidth
} from '../../workspace/utils/workspaceState';
import { useArtifactFetcher } from '../contexts/ArtifactFetchContext';
import ArtifactViewerContext from '../contexts/ArtifactViewerContext';
import {
  artifactDisplayName,
  blobOfBase64,
  collectOpenableArtifacts,
  isLiveArtifact,
  saveName
} from '../utils/artifactFiles';
import ArtifactsPanel from './ArtifactsPanel';
import ArtifactViewer from './ArtifactViewer';
import UploadedFileDetail from './UploadedFilesTab';

// A cited source is shown with pdf.js and the integrations API: loaded on its first open.
const SourceDetail = lazy(() => import('../../workspace/components/SourceDetail'));

/** Name of the search parameter that records the open artifact in the chat URL. */
export const ARTIFACT_PARAM = PANE_PARAMS.artifact;

/** Id of the pane heading: focused when the pane opens, and the skip link's target. */
export const WORKSPACE_HEADING_ID = 'workspace-pane-heading';

/** Where `Layout` keeps room for the "Skip to workspace" link, right after its own skip link. */
const SKIP_SLOT_ID = 'workspace-skip-link-slot';

const keyOf = target => (target.kind === 'files' ? 'files' : `${target.kind}:${target.id}`);
const tabOf = kind => (kind === 'file' ? 'uploaded' : kind === 'source' ? 'sources' : 'generated');

/** The visible element of an F6 region (the chat mounts a phone and a desktop copy). */
function visibleRegion(name) {
  const candidates = Array.from(document.querySelectorAll(`[data-f6-region="${name}"]`)).filter(
    element => !element.closest('[hidden], [inert]')
  );
  // Without layout information (no copy has a box) the first one not hidden is it.
  return (
    candidates.find(
      element => element.offsetParent !== null || element.getClientRects().length > 0
    ) ||
    (candidates.every(element => element.getClientRects().length === 0) && candidates.length === 1
      ? candidates[0]
      : null)
  );
}

function focusRegion(name, element) {
  if (name === 'composer') {
    (element.querySelector('textarea') || element).focus();
    return;
  }
  if (name === 'pane') {
    (document.getElementById(WORKSPACE_HEADING_ID) || element).focus();
    return;
  }
  if (name === 'sidebar') {
    element.querySelector('a[href], button:not([disabled])')?.focus();
    return;
  }
  element.focus();
}

/**
 * Owns the workspace pane of a chat page (concept "Workspace Pane for
 * Artifacts, Files and Sources") and offers `openArtifact`, `openFile`,
 * `openFiles` and `openSource` to everything below it.
 *
 * **State.** The pane is closed, docked or full screen, and shows the Files
 * index or one item (artifact, uploaded file, cited source). What it shows
 * lives in the URL — `?artifact=`, `?file=`, `?source=`, `?files=<tab>`, plus
 * `&view=full` — so a reload or a copied link reopens it. Opening the pane
 * pushes one history entry, switching items replaces it, full screen pushes
 * one more: Back steps out one level at a time. A live-turn file (no id the
 * server knows) is kept in memory instead.
 *
 * **Presentation.** With `inline`, a `WorkspaceLayout` below places the pane
 * next to the chat (docked) or over the chat column (full screen); the same
 * element in both, so the viewer is never remounted. Below 1024px, on an
 * embedded surface (Outlook, the extension, an embed) and without `inline`,
 * the pane is a full-screen sheet with a focus trap instead.
 *
 * **Keyboard.** Esc closes the innermost layer while focus is in the pane,
 * never from the composer. With `inline`: Ctrl/Cmd+. toggles the pane,
 * Ctrl/Cmd+Shift+E toggles full screen, F6 / Shift+F6 cycle sidebar → chat
 * log → composer → pane.
 *
 * @param {Object} props
 * @param {import('react').ReactNode} props.children
 * @param {Object[]} [props.messages] - The conversation.
 * @param {string} [props.chatId] - Owner's chat the stored artifacts belong to.
 * @param {(artifact: Object) => Promise<Blob>} [props.fetchBlob] - Bytes of a stored artifact;
 *   by default the owner's route (or the fetcher an `ArtifactFetchContext` supplies).
 * @param {(artifact: Object) => void} [props.onShare] - Adds Share to stored artifacts.
 * @param {(artifact: Object) => string|null} [props.newTabUrl] - Route of a standalone page
 *   for an artifact; adds "Open in new tab".
 * @param {Object} [props.files] - What the Files index lists.
 * @param {{ list: Function, fetchBlob: Function, zip?: Function }} [props.files.artifacts]
 * @param {{ list: Function, fetchText: Function, fetchBlob: Function, remove?: Function }} [props.files.uploaded]
 * @param {'none'|'extracted_text'|'original'} [props.files.uploadedAccess]
 * @param {string} [props.files.zipName]
 * @param {{ available: boolean, attach: Function }|null} [props.files.mailAttach]
 * @param {() => void} [props.files.onUploadedChanged]
 * @param {boolean} [props.inline] - A `WorkspaceLayout` hosts the pane in the page layout.
 * @param {boolean} [props.forceSheet] - Never split (embedded surfaces, the admin test panel).
 * @param {(quote: Object) => void} [props.onQuote] - "Ask about" / "Edit with AI" of a selection.
 * @param {(dock: Object) => import('react').ReactNode} [props.renderFullScreenChat] - The chat
 *   of the full-screen pane (the composer dock).
 * @param {import('react').Ref} [props.controllerRef] - Receives `{ openArtifact, openFile,
 *   openFiles, close }` for the page that renders the host.
 */
export default function ArtifactViewerHost({
  children,
  messages,
  chatId,
  fetchBlob = null,
  onShare = null,
  newTabUrl = null,
  files = null,
  inline = false,
  forceSheet = false,
  onQuote = null,
  renderFullScreenChat = null,
  controllerRef = null
}) {
  const { t } = useTranslation();
  const customFetch = useArtifactFetcher();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const embeddedKind = useEmbeddedHostKind();
  const wideViewport = useMediaQuery(`(min-width: ${SPLIT_MIN_VIEWPORT}px)`);
  const presentation = presentationOf({
    viewportWidth: wideViewport ? SPLIT_MIN_VIEWPORT : 0,
    surface: embeddedKind,
    forceSheet: forceSheet || !inline
  });
  const split = presentation === 'split';
  const outlook = embeddedKind === 'office';

  const url = readPaneParams(searchParams);
  const [live, setLive] = useState(null);
  const [liveFull, setLiveFull] = useState(false);
  const [origin, setOrigin] = useState(null);
  const [sheetHidden, setSheetHidden] = useState(false);
  const [dockExpanded, setDockExpanded] = useState(false);
  const [dockHeight, setDockHeight] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [containerWidth, setContainerWidth] = useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth
  );
  const [preferredWidth, setPreferredWidth] = useState(() => readStoredWidth());
  const knownRef = useRef(new Map());
  const openPushedRef = useRef(false);
  const fullPushedRef = useRef(false);
  const openerRef = useRef(null);
  const focusHeadingRef = useRef(false);
  const paneRef = useRef(null);
  const headingRef = useRef(null);
  const blobsRef = useRef(new Map());

  const target = url.target || live?.target || null;
  const full = url.target ? url.full : live ? liveFull : false;
  const isOpen = Boolean(target);

  const collected = useMemo(() => collectOpenableArtifacts(messages), [messages]);
  const citedSources = useMemo(() => collectCitedSources(messages), [messages]);
  const lists = useWorkspaceLists({
    artifacts: files?.artifacts || null,
    uploaded: files?.uploaded || null,
    messages,
    enabled: isOpen
  });

  // Another chat: nothing fetched or open in memory belongs to it.
  useEffect(() => {
    blobsRef.current = new Map();
    setLive(null);
    setOrigin(null);
  }, [chatId]);

  // ---- announcements: one polite live region, never streamed text ----
  const announce = useCallback(text => {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  // ---- URL bookkeeping: Back undoes what this host pushed ----
  useEffect(() => {
    if (!url.full) fullPushedRef.current = false;
    if (!url.target) {
      openPushedRef.current = false;
      fullPushedRef.current = false;
    }
  }, [url.target, url.full]);

  const write = useCallback(
    (next, nextFull, replace) =>
      setSearchParams(previous => writePaneParams(previous, next, nextFull), { replace }),
    [setSearchParams]
  );

  /**
   * Show `next` in the pane. `descriptor` is what the caller knows of the item
   * (a card's descriptor, a source with its passages); `from` the item to go
   * back to, when it differs from the Files index.
   */
  const show = useCallback(
    (next, { descriptor = null, from = null, live: isLive = false } = {}) => {
      if (descriptor) knownRef.current.set(keyOf(next), descriptor);
      if (!isOpen || sheetHidden) {
        openerRef.current = document.activeElement;
      }
      focusHeadingRef.current = true;
      setSheetHidden(false);
      setOrigin(from);
      if (isLive) {
        setLive({ target: next, descriptor });
        setLiveFull(url.target ? url.full : liveFull);
        if (url.target) write(null, false, true);
        return;
      }
      const wasLive = Boolean(live);
      setLive(null);
      if (url.target) {
        if (!sameTarget(url.target, next)) {
          // The full-screen entry now shows `next`: leaving full screen has to
          // replace it in place, not go Back to the item it was pushed for.
          if (url.full) fullPushedRef.current = false;
          write(next, url.full, true);
        }
      } else {
        const push = !wasLive && !isOpen;
        if (push) openPushedRef.current = true;
        write(next, wasLive ? liveFull : false, !push);
      }
    },
    [isOpen, sheetHidden, url.target, url.full, live, liveFull, write]
  );

  const close = useCallback(() => {
    setLive(null);
    setLiveFull(false);
    setOrigin(null);
    setDockExpanded(false);
    setSheetHidden(false);
    if (url.target) {
      const steps = (openPushedRef.current ? 1 : 0) + (fullPushedRef.current ? 1 : 0);
      if (openPushedRef.current) navigate(-steps);
      else write(null, false, true);
      openPushedRef.current = false;
      fullPushedRef.current = false;
    }
  }, [url.target, navigate, write]);

  const setFull = useCallback(
    on => {
      setDockExpanded(false);
      if (!url.target) {
        setLiveFull(on);
        return;
      }
      if (on && !url.full) {
        fullPushedRef.current = true;
        write(url.target, true, false);
      } else if (!on && url.full) {
        if (fullPushedRef.current) navigate(-1);
        else write(url.target, false, true);
        fullPushedRef.current = false;
      }
    },
    [url.target, url.full, write, navigate]
  );

  // ---- focus: heading on a user open, opener (or the composer) on close ----
  const wasOpenRef = useRef(isOpen);
  // A string, not the target object: that is new on every render, and a cleanup on
  // each one would cancel the frame that moves the focus.
  const targetKey = target ? keyOf(target) : '';
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (isOpen && focusHeadingRef.current) {
      const frame = requestAnimationFrame(() => {
        focusHeadingRef.current = false;
        headingRef.current?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    if (wasOpen && !isOpen) {
      const opener = openerRef.current;
      openerRef.current = null;
      const frame = requestAnimationFrame(() => {
        if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
        else visibleRegion('composer')?.querySelector('textarea')?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [isOpen, targetKey]);

  // ---- the sidebar folds to its rail while a docked pane is open below 1280px ----
  const splitOpen = isOpen && split;
  useEffect(() => {
    if (!splitOpen) return undefined;
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_PANE_EVENT, {
        detail: {
          open: true,
          onCollapsed: () =>
            announce(t('workspace.sidebarCollapsed', 'Sidebar collapsed to make room'))
        }
      })
    );
    return () =>
      window.dispatchEvent(new CustomEvent(WORKSPACE_PANE_EVENT, { detail: { open: false } }));
  }, [splitOpen, announce, t]);

  // ---- Esc: innermost layer first, only from inside the pane, never from the composer ----
  useEffect(() => {
    if (!isOpen || sheetHidden) return undefined;
    const onKeyDown = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const active = document.activeElement;
      const layer = escapeLayer({
        dockExpanded,
        full: full && split,
        inPane: Boolean(paneRef.current?.contains(active)),
        inComposer:
          active?.tagName === 'TEXTAREA' || Boolean(active?.closest?.('[data-workspace-composer]'))
      });
      if (!layer) return;
      event.preventDefault();
      if (layer === 'dock') {
        setDockExpanded(false);
        requestAnimationFrame(() =>
          paneRef.current?.querySelector('[data-testid="composer-dock-expand"]')?.focus()
        );
      } else if (layer === 'full') setFull(false);
      else close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, sheetHidden, dockExpanded, full, split, setFull, close]);

  // ---- descriptors ----
  const generatedItems = lists.generated.items;
  const uploadedItems = lists.uploaded.items;
  const resolve = useCallback(
    next => {
      if (!next || next.kind === 'files') return null;
      if (live && sameTarget(live.target, next)) return live.descriptor;
      if (next.kind === 'artifact') {
        return (
          collected.find(item => item.id === next.id) ||
          knownRef.current.get(keyOf(next)) ||
          generatedItems.find(item => item.id === next.id) ||
          null
        );
      }
      if (next.kind === 'file') {
        return uploadedItems.find(item => item.id === next.id) || null;
      }
      const cited = citedSources.find(entry => entry.source.id === next.id);
      const known = knownRef.current.get(keyOf(next));
      if (known) return known;
      if (!cited) return null;
      // Kept: the citations are rebuilt on every message update, and a new
      // object would make the source view fetch its document again.
      const descriptor = { source: cited.source };
      knownRef.current.set(keyOf(next), descriptor);
      return descriptor;
    },
    [live, collected, generatedItems, uploadedItems, citedSources]
  );

  const getBlob = useCallback(
    artifact => {
      if (artifact.data) return Promise.resolve(blobOfBase64(artifact.data, artifact.mimeType));
      if (!blobsRef.current.has(artifact.id)) {
        const pending = fetchBlob
          ? fetchBlob(artifact)
          : files?.artifacts?.fetchBlob && !customFetch
            ? files.artifacts.fetchBlob(artifact.id)
            : (customFetch || fetchChatArtifact)(chatId, artifact.id);
        pending.catch(() => blobsRef.current.delete(artifact.id));
        blobsRef.current.set(artifact.id, pending);
      }
      return blobsRef.current.get(artifact.id);
    },
    [fetchBlob, files?.artifacts, customFetch, chatId]
  );

  // ---- what the page and the cards may do ----
  const openArtifact = useCallback(
    given => {
      if (!given) return;
      // A live picture has no id yet: give it the key the chat's list knows it by.
      const artifact = given.id
        ? given
        : collected.find(item => item.data && item.data === given.data) || {
            ...given,
            id: `live:open:${Date.now()}`
          };
      show(
        { kind: 'artifact', id: artifact.id },
        { descriptor: artifact, live: isLiveArtifact(artifact) }
      );
    },
    [collected, show]
  );

  const openFiles = useCallback(tab => show({ kind: 'files', tab: tab || null }), [show]);
  const openFile = useCallback(
    file => {
      const id = typeof file === 'string' ? file : file?.id;
      if (id) show({ kind: 'file', id });
    },
    [show]
  );
  const openSource = useCallback(
    (source, focus = null) => {
      if (!source?.id || !split) return false;
      const current = target && target.kind !== 'files' && target.kind !== 'source' ? target : null;
      const currentDescriptor = current ? resolve(current) : null;
      show(
        { kind: 'source', id: source.id },
        {
          descriptor: { source, focus },
          from: current
            ? {
                target: current,
                descriptor: currentDescriptor,
                label:
                  current.kind === 'artifact'
                    ? artifactDisplayName(currentDescriptor || {})
                    : currentDescriptor?.name || t('chatFiles.title', 'Files')
              }
            : null
        }
      );
      return true;
    },
    [split, target, resolve, show, t]
  );

  // ---- global shortcuts of a chat page ----
  const toggle = useCallback(() => {
    if (isOpen && !sheetHidden) close();
    else if (isOpen) {
      openerRef.current = document.activeElement;
      focusHeadingRef.current = true;
      setSheetHidden(false);
    } else openFiles(null);
  }, [isOpen, sheetHidden, close, openFiles]);

  useEffect(() => {
    if (!inline) return undefined;
    const onKeyDown = event => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.shiftKey && !event.altKey && event.key === '.') {
        event.preventDefault();
        toggle();
        return;
      }
      if (mod && event.shiftKey && event.key?.toLowerCase() === 'e' && isOpen && split) {
        event.preventDefault();
        setFull(!full);
        return;
      }
      if (event.key === 'F6') {
        // A sheet is modal: the regions behind it are not reachable.
        if (isOpen && !split && !sheetHidden) {
          event.preventDefault();
          headingRef.current?.focus();
          return;
        }
        const order = ['sidebar', 'chatlog', 'composer', 'pane'];
        const regions = order
          .map(name => [name, visibleRegion(name)])
          .filter(([, element]) => element);
        if (regions.length === 0) return;
        event.preventDefault();
        const active = document.activeElement;
        const index = regions.findIndex(([, element]) => element.contains(active));
        const step = event.shiftKey ? -1 : 1;
        const next =
          index === -1
            ? event.shiftKey
              ? regions.length - 1
              : 0
            : (index + step + regions.length) % regions.length;
        focusRegion(...regions[next]);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [inline, toggle, isOpen, split, full, setFull]);

  useImperativeHandle(controllerRef, () => ({ openArtifact, openFile, openFiles, close }), [
    openArtifact,
    openFile,
    openFiles,
    close
  ]);

  const activeId = target && target.kind !== 'files' ? target.id : null;
  const context = useMemo(
    () => ({
      openArtifact,
      openFile,
      openFiles,
      openSource,
      sourcesInPane: split,
      activeId,
      shareArtifact: onShare || null
    }),
    [openArtifact, openFile, openFiles, openSource, split, activeId, onShare]
  );

  // ---- width ----
  const width = clampPaneWidth(preferredWidth ?? defaultPaneWidth(containerWidth), containerWidth);
  const onResize = useCallback(
    (next, how) => {
      const clamped = clampPaneWidth(next, containerWidth);
      setPreferredWidth(clamped);
      if (how === 'key') {
        announce(
          t('workspace.widthPercent', 'Workspace {{percent}} percent', {
            percent: widthPercent(clamped, containerWidth)
          })
        );
      }
    },
    [containerWidth, announce, t]
  );
  const onResizeEnd = useCallback(() => {
    setPreferredWidth(current => {
      writeStoredWidth(current);
      return current;
    });
  }, []);
  const onResetWidth = useCallback(() => {
    writeStoredWidth(null);
    setPreferredWidth(null);
    announce(
      t('workspace.widthPercent', 'Workspace {{percent}} percent', {
        percent: widthPercent(defaultPaneWidth(containerWidth), containerWidth)
      })
    );
  }, [containerWidth, announce, t]);

  // ---- the pane's content ----
  let pane = null;
  let title = '';
  if (isOpen) {
    const descriptor = resolve(target);
    const paneWidth = split && !full ? width : containerWidth;
    const showDock = Boolean(renderFullScreenChat) && (full || !split);
    const closeLabel = !split
      ? t('workspace.backToChat', 'Back to chat')
      : t('workspace.close', 'Close workspace');
    const generatedForSwitch = lists.generated.status === 'ready' ? generatedItems : collected;
    const switcher = {
      groups: [
        {
          label: t('chatFiles.tabGenerated', 'Generated'),
          items: generatedForSwitch.map(item => ({
            key: `a:${item.id}`,
            name: artifactDisplayName(item),
            current: target.kind === 'artifact' && target.id === item.id,
            onSelect: () =>
              show(
                { kind: 'artifact', id: item.id },
                { descriptor: item, from: origin, live: isLiveArtifact(item) }
              )
          }))
        },
        {
          label: t('chatFiles.tabUploaded', 'Uploaded'),
          items: uploadedItems.map(item => ({
            key: `f:${item.id}`,
            name: item.name,
            current: target.kind === 'file' && target.id === item.id,
            onSelect: () => show({ kind: 'file', id: item.id }, { from: origin })
          }))
        },
        ...(split
          ? [
              {
                label: t('workspace.tabSources', 'Sources'),
                items: citedSources.map(entry => ({
                  key: `s:${entry.source.id}`,
                  name: entry.source.title || entry.source.fileName || entry.source.url || '',
                  current: target.kind === 'source' && target.id === entry.source.id,
                  onSelect: () =>
                    show(
                      { kind: 'source', id: entry.source.id },
                      { descriptor: { source: entry.source }, from: origin }
                    )
                }))
              }
            ]
          : [])
      ]
    };
    const chrome = {
      headingId: WORKSPACE_HEADING_ID,
      headingRef,
      full: full || !split,
      paneWidth,
      announce,
      onQuote: onQuote
        ? quote => {
            onQuote(quote);
            if (!split) setSheetHidden(true);
            // In full screen the composer is the dock's: open it, so the quote and
            // the caret are in view.
            else if (full && renderFullScreenChat) setDockExpanded(true);
            announce(t('workspace.quoted', 'Quoted in the message box'));
          }
        : null,
      bottomPadding: showDock ? dockHeight : 0,
      // "Answer 3": the chat has to be in view before it can scroll to the answer.
      onRevealMessage: messageId => {
        if (split && full) setFull(false);
        else if (!split) setSheetHidden(true);
        // The chat column shows again a frame or two later (Back is asynchronous).
        let tries = 0;
        const attempt = () => {
          if (!revealMessage(messageId) && tries++ < 20) requestAnimationFrame(attempt);
        };
        requestAnimationFrame(attempt);
      },
      back:
        target.kind === 'files'
          ? null
          : origin
            ? {
                label: origin.label,
                onBack: () =>
                  show(origin.target, {
                    descriptor: origin.descriptor,
                    live: Boolean(live && sameTarget(live.target, origin.target))
                  })
              }
            : {
                label: t('chatFiles.title', 'Files'),
                onBack: () => show({ kind: 'files', tab: tabOf(target.kind) })
              },
      switcher,
      expand: split ? { full, onToggle: () => setFull(!full) } : null,
      close: { label: closeLabel, onClose: close },
      more: []
    };

    let content;
    if (target.kind === 'files') {
      title = t('chatFiles.title', 'Files');
      content = (
        <ArtifactsPanel
          chrome={chrome}
          tab={target.tab}
          onTab={tab => show({ kind: 'files', tab })}
          generated={files?.artifacts ? lists.generated : { status: 'ready', items: collected }}
          uploaded={files?.uploaded ? lists.uploaded : null}
          sources={citedSources}
          messages={messages}
          activeId={null}
          onOpenArtifact={item =>
            show(
              { kind: 'artifact', id: item.id },
              { descriptor: item, live: isLiveArtifact(item) }
            )
          }
          onOpenFile={item => show({ kind: 'file', id: item.id })}
          onOpenSource={split ? entry => openSource(entry.source) : null}
          zip={files?.artifacts?.zip || null}
          zipName={files?.zipName}
          uploadedAccess={files?.uploadedAccess || null}
        />
      );
    } else if (target.kind === 'artifact' && descriptor) {
      title = artifactDisplayName(descriptor);
      const stored = !isLiveArtifact(descriptor);
      const newTab = stored && newTabUrl ? newTabUrl(descriptor) : null;
      const mailAttach = files?.mailAttach?.available ? files.mailAttach : null;
      const attachToMail = mailAttach
        ? {
            prominent: outlook,
            run: () =>
              mailAttach.attach({
                file: { name: saveName(artifactDisplayName(descriptor)), bytes: descriptor.bytes },
                fetchBlob: () => getBlob(descriptor)
              })
          }
        : null;
      content = (
        <ArtifactViewer
          artifact={descriptor}
          getBlob={getBlob}
          chrome={chrome}
          onShare={onShare && stored ? onShare : null}
          onShowInFiles={() => show({ kind: 'files', tab: 'generated' })}
          onOpenInNewTab={
            newTab
              ? async () => {
                  // Loaded on demand: the base path is only needed here.
                  const { buildPath } = await import('../../../utils/runtimeBasePath');
                  openExternalUrl(new URL(buildPath(newTab), window.location.origin).href);
                }
              : null
          }
          attachToMail={attachToMail}
        />
      );
    } else if (target.kind === 'file' && files?.uploaded) {
      title = descriptor?.name || t('chatFiles.title', 'Files');
      content = (
        <UploadedFileDetail
          file={descriptor}
          status={lists.uploaded.status}
          source={files.uploaded}
          access={files.uploadedAccess || null}
          mailAttach={files.mailAttach || null}
          attachProminent={outlook}
          chrome={chrome}
          onDeleted={() => {
            lists.reloadUploaded();
            files.onUploadedChanged?.();
            show({ kind: 'files', tab: 'uploaded' });
          }}
        />
      );
    } else if (target.kind === 'source' && descriptor?.source) {
      title = descriptor.source.title || descriptor.source.fileName || '';
      content = (
        <Suspense fallback={null}>
          <SourceDetail
            key={descriptor.source.id}
            source={descriptor.source}
            focus={descriptor.focus}
            chrome={chrome}
          />
        </Suspense>
      );
    } else {
      // Deleted, expired, or a link to something this chat does not have.
      const loading =
        (target.kind === 'artifact' &&
          files?.artifacts &&
          lists.generated.status !== 'ready' &&
          lists.generated.status !== 'error') ||
        (target.kind === 'file' &&
          lists.uploaded.status !== 'ready' &&
          lists.uploaded.status !== 'error');
      title = t('chatFiles.title', 'Files');
      content = <ArtifactsPanelGone chrome={chrome} loading={Boolean(loading)} />;
    }

    pane = (
      <WorkspacePane
        presentation={presentation}
        full={full}
        hidden={!split && sheetHidden}
        title={title}
        width={width}
        containerWidth={containerWidth}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        onResetWidth={onResetWidth}
        announcement={announcement}
        paneRef={paneRef}
        dock={
          showDock
            ? renderFullScreenChat({
                expanded: dockExpanded,
                onExpandedChange: setDockExpanded,
                onHeightChange: setDockHeight,
                onOpenChat: () => {
                  setDockExpanded(false);
                  if (split) setFull(false);
                  else setSheetHidden(true);
                }
              })
            : null
        }
      >
        {content}
      </WorkspacePane>
    );
  }

  const layout = useMemo(
    () => ({
      pane: split ? pane : null,
      split: split && isOpen,
      full,
      setContainerWidth
    }),
    [split, pane, isOpen, full]
  );

  const skipSlot =
    splitOpen && typeof document !== 'undefined' ? document.getElementById(SKIP_SLOT_ID) : null;

  return (
    <ArtifactViewerContext.Provider value={context}>
      <WorkspaceLayoutContext.Provider value={inline ? layout : null}>
        {children}
        {!split && pane}
        {skipSlot &&
          createPortal(
            <SkipLink
              targetId={WORKSPACE_HEADING_ID}
              className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-48 focus:p-3 focus:bg-white focus:text-indigo-600 focus:rounded-md focus:shadow-lg focus:underline dark:focus:bg-gray-800 dark:focus:text-indigo-400"
            >
              {t('workspace.skipToWorkspace', 'Skip to workspace')}
            </SkipLink>,
            skipSlot
          )}
      </WorkspaceLayoutContext.Provider>
    </ArtifactViewerContext.Provider>
  );
}

/** The pane's explicit empty state for an item that is gone (concept §10), never a 404. */
function ArtifactsPanelGone({ chrome, loading }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-item-gone">
      <header className="flex h-12 flex-none items-center gap-1 border-b border-gray-200 bg-white px-2 dark:border-gray-700 dark:bg-gray-800">
        {chrome.back && (
          <button
            type="button"
            onClick={chrome.back.onBack}
            className={`${GHOST_BUTTON} px-1.5`}
            data-testid="pane-back"
          >
            <Icon name="chevron-left" size="sm" />
            {chrome.back.label}
          </button>
        )}
        <h2
          id={chrome.headingId}
          ref={chrome.headingRef}
          tabIndex={-1}
          className="m-0 px-2 text-sm font-semibold text-gray-900 focus:outline-none dark:text-gray-100"
        >
          {t('chatFiles.title', 'Files')}
        </h2>
        <button
          type="button"
          onClick={chrome.close.onClose}
          className={`${GHOST_BUTTON} ml-auto`}
          aria-label={chrome.close.label}
          data-testid="artifact-viewer-close"
        >
          <Icon name="x" size="md" />
        </button>
      </header>
      <p className="p-6 text-sm text-gray-700 dark:text-gray-200" role="status">
        {loading
          ? t('chatArtifacts.previewLoading', 'Loading preview…')
          : t('workspace.itemGone', 'This file is no longer available in this chat.')}
      </p>
    </div>
  );
}
