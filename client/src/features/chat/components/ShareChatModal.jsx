import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { createChatShare, fetchChatShares, lookupUsers, revokeChatShare } from '../../../api';
import { buildPath } from '../../../utils/runtimeBasePath';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Expiry presets, in the order the select offers them. */
const EXPIRY_PRESETS = [
  { key: 'day', days: 1 },
  { key: 'week', days: 7 },
  { key: 'month', days: 30 },
  { key: 'quarter', days: 90 }
];

/** The three audiences, in the order the form offers them. */
const MODE_ORDER = ['users', 'authenticated', 'public'];

const inputClass =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500';

/**
 * The absolute URL of a share, including the deployment base path.
 *
 * @param {string} shareId - Share id.
 * @returns {string}
 */
function shareUrl(shareId) {
  return `${window.location.origin}${buildPath(`/share/${encodeURIComponent(shareId)}`)}`;
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

/** `YYYY-MM-DD` of a date in local time, for a date input. */
function toDateInputValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The end of a `YYYY-MM-DD` day in local time, as an ISO instant. */
function endOfDayIso(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

/**
 * A small copy-to-clipboard button that says when it worked.
 *
 * @param {Object} props - Component properties.
 * @param {string} props.text - What to copy.
 * @param {string} [props.className] - Extra classes.
 * @returns {JSX.Element}
 */
function CopyButton({ text, className = '' }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true))}
      className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 ${className}`}
    >
      <Icon name={copied ? 'check' : 'copy'} size="sm" />
      {copied ? t('chatSharing.copied', 'Copied') : t('chatSharing.copy', 'Copy link')}
    </button>
  );
}

/**
 * The state pill of one share in the owner's list.
 *
 * @param {Object} props - Component properties.
 * @param {string} props.state - `active | revoked | expired | exhausted`.
 * @returns {JSX.Element}
 */
function StateBadge({ state }) {
  const { t } = useTranslation();
  const labels = {
    active: t('chatSharing.state.active', 'Active'),
    revoked: t('chatSharing.state.revoked', 'Revoked'),
    expired: t('chatSharing.state.expired', 'Expired'),
    exhausted: t('chatSharing.state.exhausted', 'View limit reached')
  };
  const tone =
    state === 'active'
      ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';
  return (
    <span className={`inline-block text-[11px] font-semibold rounded-full px-2 py-0.5 ${tone}`}>
      {labels[state] || state}
    </span>
  );
}

/**
 * One existing share of the chat: audience, state, views, recipients, revoke.
 *
 * @param {Object} props - Component properties.
 * @param {Object} props.share - Owner's view of the share.
 * @param {() => void} props.onRevoke - Ask to revoke it.
 * @returns {JSX.Element}
 */
function ShareRow({ share, onRevoke }) {
  const { t, i18n } = useTranslation();
  const modeLabel = {
    users: t('chatSharing.mode.users', 'Specific users'),
    authenticated: t('chatSharing.mode.authenticated', 'Signed-in users'),
    public: t('chatSharing.mode.public', 'Public')
  }[share.mode];
  const modeIcon = { users: 'user-group', authenticated: 'lock-closed', public: 'globe-alt' }[
    share.mode
  ];
  const active = share.state === 'active';
  return (
    <li className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Icon name={modeIcon} size="sm" className="text-gray-500" />
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{modeLabel}</span>
        <StateBadge state={share.state} />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {formatDate(share.createdAt, i18n.language)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {active && <CopyButton text={shareUrl(share.id)} />}
          {active && (
            <button
              type="button"
              onClick={onRevoke}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <Icon name="ban" size="sm" />
              {t('chatSharing.revoke', 'Revoke')}
            </button>
          )}
        </span>
      </div>
      <div className="text-xs text-gray-600 dark:text-gray-300 flex flex-wrap gap-x-4 gap-y-1">
        <span>
          {t('chatSharing.views', {
            count: share.viewCount || 0,
            defaultValue_one: '{{count}} view',
            defaultValue_other: '{{count}} views'
          })}
          {share.maxViews ? ` / ${share.maxViews}` : ''}
        </span>
        <span>
          {share.lastViewedAt
            ? t('chatSharing.lastViewed', {
                date: formatDate(share.lastViewedAt, i18n.language),
                defaultValue: 'Last opened {{date}}'
              })
            : t('chatSharing.neverViewed', 'Not opened yet')}
        </span>
        {share.expiresAt && (
          <span>
            {t('chatSharing.expiresOn', {
              date: formatDate(share.expiresAt, i18n.language),
              defaultValue: 'Expires {{date}}'
            })}
          </span>
        )}
      </div>
      {share.mode === 'users' && Array.isArray(share.recipientDetails) && (
        <ul className="flex flex-wrap gap-1.5">
          {share.recipientDetails.map(recipient => {
            const seen = share.recipientViews?.[recipient.id]?.count > 0;
            return (
              <li
                key={recipient.id}
                className={`inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 border ${
                  seen
                    ? 'border-green-200 dark:border-green-800 text-green-800 dark:text-green-200 bg-green-50 dark:bg-green-900/20'
                    : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300'
                }`}
                title={
                  seen
                    ? t('chatSharing.viewedBy', {
                        date: formatDate(
                          share.recipientViews[recipient.id].lastViewedAt,
                          i18n.language
                        ),
                        defaultValue: 'Opened {{date}}'
                      })
                    : t('chatSharing.notViewedBy', 'Not opened yet')
                }
              >
                <Icon name={seen ? 'check' : 'clock'} size="xs" />
                {recipient.name || recipient.email || recipient.id}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/**
 * Share a stored chat as a read-only link.
 *
 * Offers the audiences the installation allows (`platformConfig.chats.sharing`),
 * a recipient picker for `users` mode, an expiry and a view limit within the
 * admin's caps, and — for a public link — a warning that has to be
 * acknowledged before the link exists. Below the form: every link of this
 * chat with its views, and a way to revoke it.
 *
 * @param {Object} props - Component properties.
 * @param {string} props.chatId - The stored chat.
 * @param {boolean} props.isOpen - Whether the dialog is shown.
 * @param {() => void} props.onClose - Close the dialog.
 * @returns {JSX.Element|null}
 */
export default function ShareChatModal({ chatId, isOpen, onClose }) {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const sharing = platformConfig?.chats?.sharing || {};
  const allowedModes = useMemo(
    () => MODE_ORDER.filter(mode => sharing.modes?.[mode] !== false),
    [sharing.modes]
  );
  const maxExpiryDays = Number(sharing.maxExpiryDays) > 0 ? Number(sharing.maxExpiryDays) : 0;
  const defaultExpiryDays =
    Number(sharing.defaultExpiryDays) > 0 ? Number(sharing.defaultExpiryDays) : 0;
  const maxViewsCap = Number(sharing.maxViewsCap) > 0 ? Number(sharing.maxViewsCap) : 0;

  const expiryOptions = useMemo(() => {
    const options = [];
    if (!maxExpiryDays) options.push('never');
    for (const preset of EXPIRY_PRESETS) {
      if (!maxExpiryDays || preset.days <= maxExpiryDays) options.push(preset.key);
    }
    options.push('custom');
    return options;
  }, [maxExpiryDays]);

  const initialExpiry = useMemo(() => {
    if (defaultExpiryDays > 0) {
      const preset = EXPIRY_PRESETS.find(p => p.days === defaultExpiryDays);
      return preset ? preset.key : 'custom';
    }
    return expiryOptions[0];
  }, [defaultExpiryDays, expiryOptions]);

  const [mode, setMode] = useState(() =>
    allowedModes.includes('authenticated') ? 'authenticated' : allowedModes[0]
  );
  const [recipients, setRecipients] = useState([]);
  const [recipientQuery, setRecipientQuery] = useState('');
  const [recipientResults, setRecipientResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [expiry, setExpiry] = useState(initialExpiry);
  const [customDate, setCustomDate] = useState(() =>
    toDateInputValue(new Date(Date.now() + (defaultExpiryDays || 7) * DAY_MS))
  );
  const [maxViews, setMaxViews] = useState('');
  const [showOwnerName, setShowOwnerName] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [created, setCreated] = useState(null);
  const [shares, setShares] = useState({ items: [], loading: true, error: null });
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const [revokeError, setRevokeError] = useState(null);
  // The date picker's bounds, fixed when the dialog opens rather than read
  // off the clock on every render.
  const [dateBounds] = useState(() => ({
    min: toDateInputValue(new Date()),
    max: maxExpiryDays ? toDateInputValue(new Date(Date.now() + maxExpiryDays * DAY_MS)) : undefined
  }));
  const searchTimerRef = useRef(null);
  const titleRef = useRef(null);

  const loadShares = useCallback(async () => {
    setShares(prev => ({ ...prev, loading: true, error: null }));
    try {
      const result = await fetchChatShares(chatId);
      setShares({ items: result?.items || [], loading: false, error: null });
    } catch (error) {
      setShares({ items: [], loading: false, error });
    }
  }, [chatId]);

  useEffect(() => {
    if (isOpen) loadShares();
  }, [isOpen, loadShares]);

  // Recipient lookup, debounced; results never include who is already picked.
  useEffect(() => {
    if (mode !== 'users') return undefined;
    const q = recipientQuery.trim();
    if (q.length < 2) {
      setRecipientResults([]);
      return undefined;
    }
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const result = await lookupUsers(q);
        const picked = new Set(recipients.map(r => r.id));
        setRecipientResults((result?.items || []).filter(user => !picked.has(user.id)));
      } catch {
        setRecipientResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(searchTimerRef.current);
  }, [recipientQuery, mode, recipients]);

  const addRecipient = user => {
    setRecipients(prev => (prev.some(r => r.id === user.id) ? prev : [...prev, user]));
    setRecipientQuery('');
    setRecipientResults([]);
  };

  const removeRecipient = id => setRecipients(prev => prev.filter(r => r.id !== id));

  const expiresAt = useMemo(() => {
    if (expiry === 'never') return null;
    if (expiry === 'custom') return endOfDayIso(customDate);
    const preset = EXPIRY_PRESETS.find(p => p.key === expiry);
    return preset ? new Date(Date.now() + preset.days * DAY_MS).toISOString() : null;
  }, [expiry, customDate]);

  const canSubmit =
    !creating &&
    allowedModes.includes(mode) &&
    (mode !== 'users' || recipients.length > 0) &&
    (mode !== 'public' || acknowledged) &&
    (expiry !== 'custom' || Boolean(expiresAt));

  const handleCreate = async event => {
    event.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    setCreateError(null);
    try {
      const parsedViews = maxViews === '' ? null : Number(maxViews);
      const result = await createChatShare(chatId, {
        mode,
        ...(mode === 'users' ? { recipients: recipients.map(r => r.id) } : {}),
        expiresAt,
        maxViews: Number.isInteger(parsedViews) && parsedViews > 0 ? parsedViews : null,
        ...(mode === 'public' ? { showOwnerName } : {})
      });
      setCreated(result.share);
      setAcknowledged(false);
      await loadShares();
    } catch (error) {
      const detail = error?.response?.data?.error || error?.message;
      setCreateError(detail || t('chatSharing.createFailed', 'The link could not be created.'));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async share => {
    setConfirmRevoke(null);
    setRevokeError(null);
    try {
      await revokeChatShare(share.id);
      if (created?.id === share.id) setCreated(null);
      await loadShares();
    } catch {
      setRevokeError(t('chatSharing.revokeFailed', 'The link could not be revoked.'));
    }
  };

  const modeCopy = {
    users: {
      icon: 'user-group',
      label: t('chatSharing.modes.users.label', 'Specific users'),
      hint: t('chatSharing.modes.users.hint', 'Only the people you pick, after they sign in.')
    },
    authenticated: {
      icon: 'lock-closed',
      label: t('chatSharing.modes.authenticated.label', 'Anyone signed in with the link'),
      hint: t(
        'chatSharing.modes.authenticated.hint',
        'Anyone with an account here who has the link.'
      )
    },
    public: {
      icon: 'globe-alt',
      label: t('chatSharing.modes.public.label', 'Anyone with the link, no sign-in'),
      hint: t('chatSharing.modes.public.hint', 'Opens for anyone on the internet who has the link.')
    }
  };

  const expiryLabel = key =>
    ({
      never: t('chatSharing.expiry.never', 'Never'),
      day: t('chatSharing.expiry.day', 'In 1 day'),
      week: t('chatSharing.expiry.week', 'In 7 days'),
      month: t('chatSharing.expiry.month', 'In 30 days'),
      quarter: t('chatSharing.expiry.quarter', 'In 90 days'),
      custom: t('chatSharing.expiry.custom', 'On a date…')
    })[key];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      initialFocusRef={titleRef}
    >
      <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <div>
          <h2
            ref={titleRef}
            tabIndex={-1}
            className="text-lg font-semibold text-gray-900 dark:text-gray-100 outline-hidden"
          >
            {t('chatSharing.title', 'Share chat')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {t(
              'chatSharing.description',
              'Recipients get a read-only copy of this conversation as it is right now. Later messages, edits and uploaded files are not part of it.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {allowedModes.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t('chatSharing.noModes', 'Sharing chats is not available here.')}
          </p>
        ) : created ? (
          <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4 space-y-3">
            <div className="flex items-center gap-2 text-green-800 dark:text-green-200 font-semibold">
              <Icon name="check-circle" size="sm" />
              {t('chatSharing.created', 'Link created')}
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareUrl(created.id)}
                onFocus={e => e.target.select()}
                aria-label={t('chatSharing.linkLabel', 'Share link')}
                className={`${inputClass} font-mono text-xs`}
              />
              <CopyButton text={shareUrl(created.id)} />
            </div>
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {t('chatSharing.createAnother', 'Create another link')}
            </button>
          </div>
        ) : (
          <form onSubmit={handleCreate} className="space-y-5">
            <fieldset>
              <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('chatSharing.modeLabel', 'Who can open the link')}
              </legend>
              <div className="space-y-2">
                {allowedModes.map(key => (
                  <label
                    key={key}
                    className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer ${
                      mode === key
                        ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name="share-mode"
                      value={key}
                      checked={mode === key}
                      onChange={() => setMode(key)}
                      className="mt-1"
                    />
                    <Icon name={modeCopy[key].icon} size="sm" className="mt-0.5 text-gray-500" />
                    <span className="flex-1">
                      <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                        {modeCopy[key].label}
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {modeCopy[key].hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {mode === 'users' && (
              <div>
                <label
                  htmlFor="share-recipients"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  {t('chatSharing.recipientsLabel', 'Share with')}
                </label>
                {recipients.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5 mb-2">
                    {recipients.map(user => (
                      <li
                        key={user.id}
                        className="inline-flex items-center gap-1 text-xs rounded-full pl-2.5 pr-1 py-0.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200"
                      >
                        {user.name}
                        {user.email && (
                          <span className="text-indigo-500 dark:text-indigo-300">
                            {' '}
                            · {user.email}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => removeRecipient(user.id)}
                          aria-label={t('chatSharing.removeRecipient', {
                            name: user.name,
                            defaultValue: 'Remove {{name}}'
                          })}
                          className="p-0.5 rounded-full hover:bg-indigo-100 dark:hover:bg-indigo-800"
                        >
                          <Icon name="x" size="xs" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="relative">
                  <input
                    id="share-recipients"
                    type="search"
                    autoComplete="off"
                    value={recipientQuery}
                    onChange={e => setRecipientQuery(e.target.value)}
                    placeholder={t(
                      'chatSharing.recipientsPlaceholder',
                      'Search by name or e-mail…'
                    )}
                    className={inputClass}
                    aria-describedby="share-recipients-hint"
                  />
                  {recipientQuery.trim().length >= 2 && (
                    <ul
                      role="listbox"
                      className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg"
                    >
                      {searching && recipientResults.length === 0 ? (
                        <li className="px-3 py-2 text-sm text-gray-500">
                          {t('common.loading', 'Loading…')}
                        </li>
                      ) : recipientResults.length === 0 ? (
                        <li className="px-3 py-2 text-sm text-gray-500">
                          {t('chatSharing.recipientsNone', 'No matching users')}
                        </li>
                      ) : (
                        recipientResults.map(user => (
                          <li key={user.id} role="option" aria-selected={false}>
                            <button
                              type="button"
                              onClick={() => addRecipient(user)}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                            >
                              <span className="block text-gray-900 dark:text-gray-100">
                                {user.name}
                              </span>
                              {user.email && (
                                <span className="block text-xs text-gray-500 dark:text-gray-400">
                                  {user.email}
                                </span>
                              )}
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </div>
                <p
                  id="share-recipients-hint"
                  className="text-xs text-gray-500 dark:text-gray-400 mt-1"
                >
                  {t(
                    'chatSharing.recipientsHint',
                    'Only users who have signed in here before can be picked.'
                  )}
                </p>
              </div>
            )}

            {mode === 'public' && (
              <div
                role="alert"
                className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-3"
              >
                <div className="flex items-start gap-2 text-amber-900 dark:text-amber-100">
                  <Icon name="exclamation-triangle" size="sm" className="mt-0.5 flex-none" />
                  <div>
                    <p className="text-sm font-semibold">
                      {t('chatSharing.publicWarningTitle', 'This makes the conversation public')}
                    </p>
                    <p className="text-sm mt-1">
                      {t(
                        'chatSharing.publicWarning',
                        'Anyone who has the link can read this conversation and download the files it generated — without signing in, until you revoke the link or it expires. The link can be forwarded to anyone. Do not share conversations that contain internal or personal data.'
                      )}
                    </p>
                  </div>
                </div>
                <label className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-100">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={e => setAcknowledged(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    {t(
                      'chatSharing.publicAcknowledge',
                      'I understand that anyone with the link can read this conversation without signing in.'
                    )}
                  </span>
                </label>
                {!sharing.ownerNameHidden && (
                  <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={showOwnerName}
                      onChange={e => setShowOwnerName(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>{t('chatSharing.showNameLabel', 'Show my name to viewers')}</span>
                  </label>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="share-expiry"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  {t('chatSharing.expiryLabel', 'Link expires')}
                </label>
                <select
                  id="share-expiry"
                  value={expiry}
                  onChange={e => setExpiry(e.target.value)}
                  className={inputClass}
                >
                  {expiryOptions.map(key => (
                    <option key={key} value={key}>
                      {expiryLabel(key)}
                    </option>
                  ))}
                </select>
                {expiry === 'custom' && (
                  <input
                    type="date"
                    value={customDate}
                    min={dateBounds.min}
                    max={dateBounds.max}
                    onChange={e => setCustomDate(e.target.value)}
                    aria-label={t('chatSharing.expiryDateLabel', 'Expiry date')}
                    className={`${inputClass} mt-2`}
                  />
                )}
                {maxExpiryDays > 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t('chatSharing.expiryCapHint', {
                      count: maxExpiryDays,
                      defaultValue: 'Links here expire after at most {{count}} days.'
                    })}
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor="share-max-views"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  {t('chatSharing.maxViewsLabel', 'Maximum opens')}
                </label>
                <input
                  id="share-max-views"
                  type="number"
                  min={1}
                  max={maxViewsCap || undefined}
                  step={1}
                  value={maxViews}
                  onChange={e => setMaxViews(e.target.value)}
                  placeholder={
                    maxViewsCap
                      ? String(maxViewsCap)
                      : t('chatSharing.maxViewsPlaceholder', 'Unlimited')
                  }
                  className={inputClass}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {maxViewsCap > 0
                    ? t('chatSharing.maxViewsCapHint', {
                        count: maxViewsCap,
                        defaultValue: 'At most {{count}} opens per link here.'
                      })
                    : t(
                        'chatSharing.maxViewsHint',
                        'The link stops working once it has been opened this often.'
                      )}
                </p>
              </div>
            </div>

            {createError && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {createError}
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Icon name="link" size="sm" />
                {creating
                  ? t('chatSharing.creating', 'Creating…')
                  : t('chatSharing.create', 'Create link')}
              </button>
            </div>
          </form>
        )}

        <section aria-labelledby="share-existing-heading">
          <h3
            id="share-existing-heading"
            className="text-[11px] font-bold tracking-widest uppercase text-gray-500 dark:text-gray-400 mb-2"
          >
            {t('chatSharing.existingTitle', 'Links for this chat')}
          </h3>
          {revokeError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-2">
              {revokeError}
            </p>
          )}
          {shares.loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('common.loading', 'Loading…')}
            </p>
          ) : shares.error ? (
            <p className="text-sm text-red-600 dark:text-red-400">
              {t('chatSharing.loadFailed', 'The links could not be loaded.')}
            </p>
          ) : shares.items.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('chatSharing.existingEmpty', 'This chat has not been shared yet.')}
            </p>
          ) : (
            <ul className="space-y-2">
              {shares.items.map(share => (
                <ShareRow key={share.id} share={share} onRevoke={() => setConfirmRevoke(share)} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <ConfirmDialog
        isOpen={!!confirmRevoke}
        title={t('chatSharing.revokeTitle', 'Revoke this link?')}
        message={t(
          'chatSharing.revokeMessage',
          'The link stops working immediately for everyone who has it. The chat itself is not changed.'
        )}
        confirmLabel={t('chatSharing.revoke', 'Revoke')}
        danger
        onConfirm={() => confirmRevoke && handleRevoke(confirmRevoke)}
        onDeny={() => setConfirmRevoke(null)}
      />
    </Modal>
  );
}
