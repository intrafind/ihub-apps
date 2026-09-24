import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import ChatMessageList from '../components/ChatMessageList';
import { ArtifactFetchContext } from '../contexts/ArtifactFetchContext';
import { transformStoredMessage } from '../hooks/useChatMessages';
import { fetchSharedArtifact, fetchSharedChat, fetchSharedChatArtifacts } from '../../../api';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { useAuth } from '../../../shared/contexts/AuthContext';

// The tile colour a shared chat falls back to when its app is gone.
const DEFAULT_APP_COLOR = '#4f46e5';
const DEFAULT_APP_ICON = 'chat-bubble';

/**
 * The snapshot messages as the chat bubbles render them.
 *
 * Same mapping a reopened chat uses, plus the attachment placeholders: a
 * stored message carries an upload only as `{ type, name, bytes }`, the file
 * itself was never stored, so the viewer is told what is missing.
 *
 * @param {Object[]} messages - Snapshot messages from the share.
 * @returns {Object[]}
 */
function toViewerMessages(messages) {
  return (messages || []).map(stored => {
    const message = transformStoredMessage(stored);
    if (Array.isArray(stored.attachments) && stored.attachments.length > 0) {
      message.sharedAttachments = stored.attachments;
    }
    return message;
  });
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value, language) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(language || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  } catch {
    return String(value);
  }
}

/**
 * Centered message for every state that is not the transcript.
 *
 * @param {Object} props - Component properties.
 * @param {string} props.icon - Icon name.
 * @param {string} props.title - Headline.
 * @param {string} [props.description] - Supporting line.
 * @param {React.ReactNode} [props.children] - Optional action.
 * @returns {JSX.Element}
 */
function CenteredState({ icon, title, description, children }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-6">
      <div className="max-w-md w-full text-center">
        <Icon name={icon} size="xl" className="text-gray-300 dark:text-gray-600 mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
        {description && (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{description}</p>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * One artifact the shared messages reference, with view and download.
 *
 * @param {Object} props - Component properties.
 * @param {Object} props.artifact - Descriptor `{ id, kind, mimeType, bytes, name? }`.
 * @param {(id: string) => Promise<Blob>} props.fetchBlob - Fetches the bytes.
 * @returns {JSX.Element}
 */
function ArtifactRow({ artifact, fetchBlob }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(null);
  const [failed, setFailed] = useState(false);
  const name = artifact.name || `${artifact.kind || 'artifact'}-${String(artifact.id).slice(0, 8)}`;

  const withBlob = useCallback(
    async (action, handler) => {
      setBusy(action);
      setFailed(false);
      try {
        const blob = await fetchBlob(artifact.id);
        handler(URL.createObjectURL(blob));
      } catch {
        setFailed(true);
      } finally {
        setBusy(null);
      }
    },
    [artifact.id, fetchBlob]
  );

  const handleView = () =>
    withBlob('view', url => {
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });

  const handleDownload = () =>
    withBlob('download', url => {
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });

  return (
    <li className="flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <Icon
        name={artifact.kind === 'image' ? 'photograph' : 'document'}
        size="md"
        className="text-gray-400 flex-none"
      />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {name}
        </span>
        <span className="block text-xs text-gray-500 dark:text-gray-400">
          {[artifact.mimeType, formatBytes(artifact.bytes)].filter(Boolean).join(' · ')}
        </span>
        {failed && (
          <span className="block text-xs text-red-600 dark:text-red-400">
            {t('chatSharing.viewer.artifactFailed', 'The file could not be loaded.')}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={handleView}
        disabled={busy !== null}
        className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
      >
        {busy === 'view' ? t('common.loading', 'Loading…') : t('chatSharing.viewer.view', 'View')}
      </button>
      <button
        type="button"
        onClick={handleDownload}
        disabled={busy !== null}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        <Icon name="download" size="sm" />
        {t('chatSharing.viewer.download', 'Download')}
      </button>
    </li>
  );
}

/**
 * A shared chat: the frozen transcript behind `/share/:shareId`, read-only.
 *
 * Rendered outside the app shell on purpose. A `public` share opens with
 * nobody signed in, and the shell's sidebar, apps list and history are all
 * things a signed-out visitor cannot load — so the page brings its own
 * header and leaves the rest of the product behind a single link.
 *
 * The server decides who may open the link. This page only reacts: a 401
 * means "sign in and come back", a 404 means the link is gone (unknown,
 * revoked, expired or used up — deliberately indistinguishable).
 *
 * @returns {JSX.Element}
 */
export default function SharedChatPage() {
  const { shareId } = useParams();
  const { t, i18n } = useTranslation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [status, setStatus] = useState('loading');
  const [data, setData] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  // The one request in flight for this link, keyed by what it asked with.
  // Every successful open counts as a view server-side, so the page must
  // open a link exactly once: not once per StrictMode double-run, and not
  // again when the sign-in status settles after the first answer arrived.
  const requestRef = useRef(null);
  // What the last answer for this link was. Once the transcript is on
  // screen, a later sign-in state change must not open it again; only a
  // "sign in first" answer is worth retrying once the viewer has signed in.
  const settledRef = useRef(null);

  useEffect(() => {
    // Wait for the sign-in status: the request carries the viewer's
    // credentials either way, but an open made before the status is known
    // is followed by a second one when it flips — two views for one visit.
    if (authLoading) return undefined;
    if (settledRef.current?.shareId === shareId && settledRef.current.status !== 'signin') {
      return undefined;
    }
    const key = `${shareId}|${isAuthenticated ? 'in' : 'out'}`;
    if (requestRef.current?.key !== key) {
      requestRef.current = { key, promise: fetchSharedChat(shareId) };
      setStatus('loading');
      setData(null);
      setArtifacts([]);
    }
    const { promise } = requestRef.current;
    let active = true;
    (async () => {
      try {
        const result = await promise;
        if (!active) return;
        settledRef.current = { shareId, status: 'ready' };
        setData(result);
        setStatus('ready');
        const hasArtifacts = (result.messages || []).some(m => m.artifacts?.length > 0);
        if (hasArtifacts) {
          try {
            const list = await fetchSharedChatArtifacts(shareId);
            if (active) setArtifacts(list.items || []);
          } catch {
            // The transcript still reads; the file list just stays empty.
          }
        }
      } catch (error) {
        if (!active) return;
        const next =
          error?.status === 401 ? 'signin' : error?.status === 404 ? 'unavailable' : 'error';
        settledRef.current = { shareId, status: next };
        setStatus(next);
      }
    })();
    return () => {
      active = false;
    };
  }, [shareId, authLoading, isAuthenticated]);

  const share = data?.share || null;
  const messages = useMemo(() => toViewerMessages(data?.messages), [data]);
  const fetchArtifact = useCallback(
    (_chatId, artifactId) => fetchSharedArtifact(shareId, artifactId),
    [shareId]
  );
  const fetchArtifactBlob = useCallback(
    artifactId => fetchSharedArtifact(shareId, artifactId),
    [shareId]
  );

  const appName = share?.app
    ? getLocalizedContent(share.app.name, i18n.language)
    : share?.appId || '';
  const title = share?.title || t('chatSharing.viewer.untitled', 'Shared chat');

  // The document title and, for a public link, a robots hint that matches the
  // header the server sends: a public page must not end up in an index.
  useEffect(() => {
    if (!share) return undefined;
    const previousTitle = document.title;
    document.title = appName ? `${title} · ${appName}` : title;
    let meta = null;
    if (share.mode === 'public') {
      meta = document.createElement('meta');
      meta.name = 'robots';
      meta.content = 'noindex, nofollow';
      document.head.appendChild(meta);
    }
    return () => {
      document.title = previousTitle;
      if (meta) meta.remove();
    };
  }, [share, title, appName]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <LoadingSpinner size="lg" />
        <span className="sr-only">{t('common.loading', 'Loading…')}</span>
      </div>
    );
  }

  if (status === 'signin') {
    const returnUrl = `${window.location.pathname}${window.location.search}`;
    return (
      <CenteredState
        icon="lock-closed"
        title={t('chatSharing.viewer.signInTitle', 'Sign in to open this shared chat')}
        description={t(
          'chatSharing.viewer.signInHint',
          'This link was shared with signed-in users only. Sign in and you will be brought back here.'
        )}
      >
        <Link
          to={`/login?returnUrl=${encodeURIComponent(returnUrl)}`}
          className="inline-flex items-center gap-2 mt-6 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold"
        >
          <Icon name="login" size="sm" />
          {t('chatSharing.viewer.signIn', 'Sign in')}
        </Link>
      </CenteredState>
    );
  }

  if (status === 'unavailable') {
    return (
      <CenteredState
        icon="link"
        title={t('chatSharing.viewer.unavailableTitle', 'This link is no longer available')}
        description={t(
          'chatSharing.viewer.unavailableHint',
          'The share may have been revoked, expired, reached its view limit, or never existed.'
        )}
      >
        <Link
          to="/"
          className="inline-block mt-6 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          {t('chatSharing.viewer.openApp', 'Open iHub Apps')}
        </Link>
      </CenteredState>
    );
  }

  if (status === 'error' || !share) {
    return (
      <CenteredState
        icon="warning"
        title={t('chatSharing.viewer.loadFailed', 'The shared chat could not be loaded')}
      >
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          {t('app.retry', 'Retry')}
        </button>
      </CenteredState>
    );
  }

  const color = share.app?.color || DEFAULT_APP_COLOR;
  const icon = share.app?.icon || DEFAULT_APP_ICON;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      {share.mode === 'public' && (
        <div
          role="note"
          className="flex items-center justify-center gap-2 px-4 py-2 text-sm bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-100 border-b border-amber-200 dark:border-amber-800"
        >
          <Icon name="globe-alt" size="sm" />
          <span>
            {t(
              'chatSharing.viewer.publicBanner',
              'This conversation is publicly accessible. Anyone with the link can read it.'
            )}
          </span>
        </div>
      )}

      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          <span
            className="w-11 h-11 rounded-xl flex items-center justify-center flex-none text-white"
            style={{ backgroundColor: color }}
          >
            <Icon name={icon} size="md" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">
                {title}
              </h1>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                <Icon name="eye" size="xs" />
                {t('chatSharing.viewer.readOnly', 'Read-only')}
              </span>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
              {[
                appName,
                share.sharedBy
                  ? t('chatSharing.viewer.sharedBy', {
                      name: share.sharedBy,
                      defaultValue: 'Shared by {{name}}'
                    })
                  : t('chatSharing.viewer.sharedAnonymously', 'Shared with you'),
                formatDate(share.createdAt, i18n.language)
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <Link
            to="/"
            className="hidden sm:inline-flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap"
          >
            {t('chatSharing.viewer.openApp', 'Open iHub Apps')}
            <Icon name="arrow-right" size="sm" />
          </Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col max-w-4xl w-full mx-auto px-2 sm:px-6 py-4">
        <ArtifactFetchContext.Provider value={fetchArtifact}>
          <div className="flex-1 flex flex-col min-h-0">
            <ChatMessageList
              messages={messages}
              editable={false}
              readOnly
              appId={share.appId || undefined}
              chatId={share.id}
              imagesPersisted
              app={null}
              models={[]}
            />
          </div>
        </ArtifactFetchContext.Provider>

        {artifacts.length > 0 && (
          <section className="mt-4 mb-8" aria-labelledby="shared-artifacts-heading">
            <h2
              id="shared-artifacts-heading"
              className="text-[11px] font-bold tracking-widest uppercase text-gray-500 dark:text-gray-400 mb-2.5 px-1"
            >
              {t('chatSharing.viewer.artifacts', 'Files in this chat')}
            </h2>
            <ul className="flex flex-col gap-2">
              {artifacts.map(artifact => (
                <ArtifactRow key={artifact.id} artifact={artifact} fetchBlob={fetchArtifactBlob} />
              ))}
            </ul>
          </section>
        )}

        {share.expiresAt && (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center mb-4">
            {t('chatSharing.viewer.expires', {
              date: formatDate(share.expiresAt, i18n.language),
              defaultValue: 'This link expires on {{date}}.'
            })}
          </p>
        )}
      </main>
    </div>
  );
}
