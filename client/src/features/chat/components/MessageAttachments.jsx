// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { memo, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { contentLineFromInfo } from '../../upload/utils/attachmentDescription';
import { useStoredThumbnail } from '../messageAttachments/useStoredThumbnail';
import { useArtifactViewer } from '../contexts/ArtifactViewerContext';
import { PDF_LOOK, formatBytes } from '../utils/artifactFiles';
import { uploadedFileBadge, uploadedFileLook } from '../utils/uploadedFiles';

/**
 * How many cards a message shows before the rest folds into "+N more files":
 * documents and other rows, and images as a grid. Narrow (a task pane, a
 * compare panel) folds one card earlier than wide. A fold never hides exactly
 * one card: `visibleCount` shows that card instead of a "+1" button.
 */
const FOLD_CAPS = {
  wide: { rows: 4, images: 6 },
  narrow: { rows: 3, images: 4 }
};
/** A window narrower than this (px) is narrow: the fold is earlier, the cards compact. */
const NARROW_BELOW_PX = 480;

/** Images up to this many sit in the list as rows with a small thumbnail. */
const MAX_IMAGE_ROWS = 2;

export const visibleCount = (total, cap) => (total <= cap ? total : cap - 1);

// Every colour in one place. The card is white (dark: gray-800) on the page, outside the bubble;
// the pairs are contrast-checked (see concepts/2026-11-07 Message Attachments, UI spec). The
// focus ring is indigo-400 in dark mode: indigo-500 is below 3:1 there. Disabled never uses
// opacity, which would break 4.5:1 for the name and size.
const RING =
  'focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-indigo-400 dark:focus-visible:ring-offset-gray-900';
const STYLES = {
  card: 'group relative flex w-full min-h-14 min-w-0 scroll-my-24 items-center rounded-lg border border-gray-300 bg-white text-left text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 contrast-more:border-gray-500 dark:contrast-more:border-gray-400',
  // Open in the workspace pane right now (concept §8).
  cardActive:
    '!border-indigo-500 ring-1 ring-indigo-500/30 !bg-indigo-50/40 dark:!bg-indigo-900/20',
  cardOpenable: `cursor-pointer transition-colors hover:border-indigo-300 hover:bg-gray-50 hover:shadow-xs active:bg-gray-100 dark:hover:border-indigo-600 dark:hover:bg-gray-700/50 dark:active:bg-gray-700 ${RING}`,
  warn: 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20',
  noAccess:
    'border-dashed border-gray-500 bg-gray-50 dark:border-gray-400 dark:bg-gray-800/60 contrast-more:border-gray-700',
  tile: 'flex shrink-0 items-center justify-center overflow-hidden rounded-md',
  meta: 'block text-xs text-gray-600 dark:text-gray-300',
  facts: 'mt-0.5 flex items-start gap-1 text-xs text-gray-600 dark:text-gray-300',
  factsWarn: 'mt-0.5 flex items-start gap-1 text-xs text-amber-800 dark:text-amber-200',
  chevron: 'size-4 shrink-0 text-gray-500 dark:text-gray-400 print:hidden',
  fold: `inline-flex min-h-9 items-center rounded-md px-2 text-sm font-medium text-indigo-700 hover:underline pointer-coarse:min-h-11 dark:text-indigo-300 ${RING}`
};

const AUDIO_LOOK = {
  icon: 'musical-note',
  className: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
};
const NEUTRAL_LOOK = {
  icon: 'paper-clip',
  className: 'bg-gray-100 text-gray-700 dark:bg-gray-700/50 dark:text-gray-200'
};

/** Whether a card is a button: there is a workspace pane to open it in and a stored file to open. */
const isOpenable = (view, onOpenFile) => Boolean(onOpenFile && view.id && view.shared !== false);

/** The type label (PDF, DOCX), from the media type, else the extension. */
const typeOf = view => uploadedFileBadge({ mimeType: view.mimeType, name: view.name });

/** Icon and tile colours of a card. */
function lookOfView(view) {
  if (view.kind === 'audio') return AUDIO_LOOK;
  if (!view.mimeType) {
    return view.kind === 'image' ? uploadedFileLook({ mimeType: 'image/png' }) : NEUTRAL_LOOK;
  }
  const look = uploadedFileLook({ mimeType: view.mimeType, name: view.name });
  // `fileLookOf` falls back to the PDF look for a type it does not know; only a PDF keeps it
  if (look === PDF_LOOK && typeOf(view) !== 'PDF') return NEUTRAL_LOOK;
  return look;
}

/**
 * The one line under a card's name: what the assistant got from the file, or the one abnormal
 * thing about it. Said only as far as the message knows it; `tone` picks the row's colours and
 * `icon` marks a notice (never colour alone).
 *
 * @returns {{ text: string, tone: 'plain'|'warn'|'noAccess', icon: string|null }|null}
 */
function stateLineOf(view, t) {
  if (view.shared === false) {
    return {
      text: t('chatMessage.attachments.notShared', 'Not shared by the owner'),
      tone: 'noAccess',
      icon: 'lock-closed'
    };
  }
  if (view.unsaved) {
    return {
      text: t(
        'chatMessage.attachments.notSaved',
        'Not saved to the chat · sent with this message only'
      ),
      tone: 'warn',
      icon: 'exclamation-triangle'
    };
  }
  if (view.read) {
    const text = contentLineFromInfo(view.read, t);
    if (!text) return null;
    const notice = view.read.truncated === true || view.read.pageImages > 0;
    return { text, tone: 'plain', icon: notice ? 'information-circle' : null };
  }
  if (view.kind === 'document' && view.originalKept === false) {
    return {
      text: t('chatMessage.attachments.textOnly', 'Text only'),
      tone: 'plain',
      icon: 'information-circle'
    };
  }
  return null;
}

/**
 * Whether a card has to fetch its picture: a stored picture the viewer may read, with none in
 * memory. A picture of a shared chat that the owner did not share is not fetched.
 */
const needsStoredThumbnail = view =>
  view.kind === 'image' && !view.previewSrc && Boolean(view.id) && view.shared !== false;

/** The size under a card's name. Once only the text is kept, `bytes` is the text's size, not the file's. */
const sizeOf = view => (view.bytes && view.originalKept !== false ? formatBytes(view.bytes) : '');

/** The card's surface classes: the warning and no-access cards change the border and background. */
function surfaceOf(tone) {
  if (tone === 'warn') return `${STYLES.card} ${STYLES.warn}`;
  if (tone === 'noAccess') return `${STYLES.card} ${STYLES.noAccess}`;
  return STYLES.card;
}

/** Padding and gaps: a grid tile stacks, a row is looser when there is room. */
function spacingOf(grid, compact) {
  if (grid) return 'flex-col items-stretch p-2';
  return compact ? 'gap-2 p-2' : 'gap-3 px-3 py-2';
}

/** The size class of a row's tile: an image thumbnail is a little larger than an icon. */
function rowTileSize(showThumb, compact) {
  if (showThumb) return 'size-10 border border-black/10 dark:border-white/20';
  return compact ? 'size-8' : 'size-9';
}

/** What a tile shows: the image as it was sent, or the icon of the file's type. */
function TileContent({ thumbSrc, look, showThumb }) {
  if (showThumb) {
    return <img src={thumbSrc} alt="" className="size-full object-cover" draggable={false} />;
  }
  return <Icon name={look.icon} size="md" aria-hidden="true" />;
}

/** A grid tile: the picture, its name below; the details are for the screen reader only. */
function GridBody({ view, thumbSrc, look, showThumb, name, size, line }) {
  return (
    <>
      <span
        className={`${STYLES.tile} aspect-square w-full border border-black/10 dark:border-white/20 ${look.className}`}
        aria-hidden="true"
      >
        <TileContent thumbSrc={thumbSrc} look={look} showThumb={showThumb} />
      </span>
      <span className="mt-1 block w-full min-w-0 truncate text-xs font-medium" title={name}>
        {name}
      </span>
      {/* The tile has no room for the details: the screen reader still gets them */}
      <span className="sr-only">
        {', '}
        {typeOf(view)}
        {size ? `, ${size}` : ''}
        {line ? `, ${line.text}` : ''}
      </span>
    </>
  );
}

/** The type and size under a row's name. */
function RowMeta({ view, size }) {
  return (
    <span className={STYLES.meta}>
      <span className="sr-only">, </span>
      <span className="font-semibold tracking-wide">{typeOf(view)}</span>
      {size && (
        <>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {size}
        </>
      )}
    </span>
  );
}

/** The state line of a row: the button's description, not text of its own. */
function RowLine({ line, lineId }) {
  return (
    // A screen reader that announces new messages would otherwise read every card's facts as the
    // card appears
    <span
      id={lineId}
      aria-hidden="true"
      className={line.tone === 'warn' ? STYLES.factsWarn : STYLES.facts}
    >
      {line.icon && <Icon name={line.icon} className="mt-0.5 size-3 shrink-0" />}
      <span className="line-clamp-3">{line.text}</span>
    </span>
  );
}

/** A row: tile, name, type and size, the state line, and a chevron when it opens. */
function RowBody({ view, thumbSrc, look, showThumb, name, size, line, lineId, compact, openable }) {
  const noAccess = line?.tone === 'noAccess';
  return (
    <>
      <span
        className={`${STYLES.tile} ${rowTileSize(showThumb, compact)} ${look.className}`}
        aria-hidden="true"
      >
        <TileContent thumbSrc={thumbSrc} look={look} showThumb={showThumb} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`line-clamp-2 block text-sm font-medium [overflow-wrap:anywhere] ${
            noAccess ? 'text-gray-700 dark:text-gray-200' : ''
          }`}
          title={name}
        >
          {name}
        </span>
        <RowMeta view={view} size={size} />
        {line && <RowLine line={line} lineId={lineId} />}
      </span>
      {openable && !compact && (
        <Icon name="chevron-right" className={STYLES.chevron} aria-hidden="true" />
      )}
    </>
  );
}

/**
 * One file: a button that opens it in the workspace pane when there is something to open, a plain
 * card (not a tab stop) otherwise.
 */
function AttachmentCard({
  view,
  onOpenFile,
  fetchFileBlob = null,
  hintId,
  compact,
  grid = false,
  firstRevealed = false
}) {
  const { t } = useTranslation();
  const lineId = useId();
  const cardRef = useRef(null);
  const openable = isOpenable(view, onOpenFile);
  const viewer = useArtifactViewer();
  const active = openable && Boolean(viewer?.activeId) && viewer.activeId === view.id;
  const line = stateLineOf(view, t);
  // A picture sent in this session is in memory; one read back from the store is fetched
  const stored = useStoredThumbnail({
    ref: cardRef,
    fileId: needsStoredThumbnail(view) ? view.id : null,
    fetchBlob: fetchFileBlob
  });
  const thumbSrc = view.previewSrc || stored.src;
  const parts = {
    view,
    thumbSrc,
    look: lookOfView(view),
    showThumb: Boolean(view.kind === 'image' && thumbSrc),
    name: view.name || t('chatSharing.viewer.attachmentUnnamed', 'file'),
    size: sizeOf(view),
    line
  };

  // A grid tile has no room for the line as an element of its own: its text carries it instead
  const describedBy = [line && !grid ? lineId : null, openable ? hintId : null]
    .filter(Boolean)
    .join(' ');
  const shared = {
    ref: cardRef,
    className: `${surfaceOf(line?.tone)} ${spacingOf(grid, compact)}`,
    'aria-describedby': describedBy || undefined,
    'data-testid': 'message-attachment',
    'data-kind': view.kind,
    ...(firstRevealed ? { 'data-first-revealed': 'true' } : {})
  };
  const body = grid ? (
    <GridBody {...parts} />
  ) : (
    <RowBody {...parts} lineId={lineId} compact={compact} openable={openable} />
  );

  if (!openable) return <div {...shared}>{body}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpenFile(view.id)}
      {...shared}
      aria-current={active ? 'true' : undefined}
      data-active={active ? 'true' : undefined}
      className={`${shared.className} ${STYLES.cardOpenable} ${active ? STYLES.cardActive : ''}`}
    >
      {body}
    </button>
  );
}

/**
 * Whether the surface is narrow: a phone-width window (a phone, the Outlook task pane), or the
 * caller says so (`compact`: a compare panel). The viewport is what is asked, not the width of an
 * element: a message row is as wide as its content, so it cannot say how wide the column is.
 */
const NARROW_QUERY = `(max-width: ${NARROW_BELOW_PX - 1}px)`;
function useNarrow(compact) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(NARROW_QUERY).matches === true
  );
  useEffect(() => {
    const query = window.matchMedia?.(NARROW_QUERY);
    if (!query) return undefined;
    const onChange = event => setNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow || compact;
}

/**
 * The files that went with a sent message, as a block of their own above the message's bubble
 * (never inside its text). Documents, e-mails, meetings and audio are rows; images are a
 * thumbnail row up to two, a grid beyond. More than fits folds into "+N more files". A card opens
 * its file in the workspace pane when the chat has one and the file is stored.
 *
 * @param {Object} props
 * @param {import('../messageAttachments/attachmentViews').AttachmentView[]} props.attachments
 * @param {(fileId: string) => void} [props.onOpenFile] - without it the cards are plain
 * @param {(fileId: string) => Promise<Blob>} [props.fetchFileBlob] - reads a stored picture, for
 *   the thumbnail of a card that has none in memory
 * @param {boolean} [props.compact] - the surface is narrow whatever its measured width
 */
function MessageAttachments({
  attachments,
  onOpenFile = null,
  fetchFileBlob = null,
  compact = false
}) {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const toggleRef = useRef(null);
  const hintId = useId();
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const narrow = useNarrow(compact);
  const justToggledRef = useRef(null);

  const views = Array.isArray(attachments) ? attachments : [];
  const images = views.filter(view => view.kind === 'image');
  const asGrid = images.length > MAX_IMAGE_ROWS;
  const rows = views.filter(view => !(asGrid && view.kind === 'image'));
  const grid = asGrid ? images : [];

  const caps = narrow ? FOLD_CAPS.narrow : FOLD_CAPS.wide;
  const rowsShown = expanded ? rows.length : visibleCount(rows.length, caps.rows);
  const gridShown = expanded ? grid.length : visibleCount(grid.length, caps.images);
  const hidden = rows.length - rowsShown + (grid.length - gridShown);
  const foldable = rows.length > caps.rows || grid.length > caps.images;

  // After a toggle: focus the first card that appeared, or return to the button
  useEffect(() => {
    if (justToggledRef.current === null) return;
    const opened = justToggledRef.current;
    justToggledRef.current = null;
    if (opened) {
      containerRef.current?.querySelector('[data-first-revealed]')?.focus();
    } else {
      toggleRef.current?.focus();
    }
  }, [expanded]);

  if (views.length === 0) return null;

  // How many cards each group shows while folded, and so where the folded ones start
  const foldedRows = visibleCount(rows.length, caps.rows);
  const foldedTiles = visibleCount(grid.length, caps.images);

  const toggle = () => {
    const next = !expanded;
    justToggledRef.current = next;
    setAnnouncement(
      next
        ? t('chatMessage.attachments.moreShown', '{{count}} more files shown', {
            count: rows.length - foldedRows + (grid.length - foldedTiles)
          })
        : ''
    );
    setExpanded(next);
  };

  // Once expanded, focus goes to the first card that was folded away: a row if
  // any row was hidden, else the first hidden image
  const rowsWereFolded = foldedRows < rows.length;
  const firstRevealedRow = expanded && rowsWereFolded ? foldedRows : -1;
  const firstRevealedTile =
    expanded && !rowsWereFolded && foldedTiles < grid.length ? foldedTiles : -1;

  return (
    <div
      ref={containerRef}
      className="message-attachments mb-2 flex w-80 max-w-[95%] flex-col gap-2 self-end"
      data-testid="message-attachments"
    >
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style:none drops the list semantics in Safari and VoiceOver */}
      <ul
        role="list"
        aria-label={t('chatMessage.attachmentsLabel', 'Attachments')}
        className="m-0 flex list-none flex-col gap-2 p-0"
      >
        {rows.slice(0, rowsShown).map((view, index) => (
          <li key={view.key} className="min-w-0">
            <AttachmentCard
              view={view}
              onOpenFile={onOpenFile}
              fetchFileBlob={fetchFileBlob}
              hintId={hintId}
              compact={narrow}
              firstRevealed={index === firstRevealedRow}
            />
          </li>
        ))}
        {grid.length > 0 && (
          <li className="min-w-0">
            {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- as above */}
            <ul
              role="list"
              aria-label={t('chatMessage.attachments.images', 'Images')}
              className={`m-0 grid list-none gap-2 p-0 ${narrow ? 'grid-cols-2' : 'grid-cols-3'}`}
            >
              {grid.slice(0, gridShown).map((view, index) => (
                <li key={view.key} className="min-w-0">
                  <AttachmentCard
                    view={view}
                    onOpenFile={onOpenFile}
                    fetchFileBlob={fetchFileBlob}
                    hintId={hintId}
                    compact={narrow}
                    grid
                    firstRevealed={index === firstRevealedTile}
                  />
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
      {foldable && (
        <button
          ref={toggleRef}
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          className={`${STYLES.fold} self-end`}
          data-testid="message-attachments-fold"
        >
          {expanded
            ? t('chatMessage.attachments.showFewer', 'Show fewer')
            : t('chatMessage.attachments.moreFiles', '+{{count}} more files', { count: hidden })}
        </button>
      )}
      {/* Said once per card, not per read: the hint every openable card points at */}
      {views.some(view => isOpenable(view, onOpenFile)) && (
        <span id={hintId} className="sr-only">
          {t('chatMessage.attachments.opensInWorkspace', 'Opens in the workspace')}
        </span>
      )}
      <output className="sr-only">{announcement}</output>
    </div>
  );
}

export default memo(MessageAttachments);
