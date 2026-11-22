// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  deleteAdminUserApp,
  disableAdminUserApp,
  enableAdminUserApp,
  fetchAdminUserApp,
  fetchAdminUserAppRevisions,
  fetchAdminUserApps,
  fetchUserAppOfferTargets,
  getAdminApiErrorMessage,
  offerAdminUserApp,
  releaseAdminUserApp,
  withdrawAdminUserAppOffer
} from '../../../api/adminApi';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import { buildPath } from '../../../utils/runtimeBasePath';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import UserAppTakeOverDialog from './UserAppTakeOverDialog';
import Modal from '../../../shared/components/Modal';
import { useConfirmAction } from '../hooks/useConfirmAction';
import { useFilterState } from '../hooks/useFilterState';
import { deleteConfirmText } from '../utils/confirmText';
import { DataTable, SearchInput } from './data-table';
import AdminLoadError from './AdminLoadError';
import UserAppSettingsPanel from './UserAppSettingsPanel';
import {
  CALLOUT_CLASS,
  INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from './formStyles';

/**
 * The dialog behind "Take over as app…" (slice P12). It is rendered as
 * `<TakeOverDialog app={item} onClose={fn} onDone={fn} />`: `app` is the list
 * item, and `onDone(newAppId)` is called after the server created the admin
 * app; this tab then opens `/admin/apps/<newAppId>?created=1`.
 */
const TakeOverDialog = UserAppTakeOverDialog;

/** The filter chips, in the order of the design. Each key is a text of its own. */
const FILTERS = [
  { id: 'all', label: 'admin.userApps.filter.all', matches: () => true },
  { id: 'waiting', label: 'admin.userApps.filter.waiting', matches: app => isWaiting(app) },
  {
    id: 'everyone',
    label: 'admin.userApps.filter.everyone',
    matches: app => app.sharedWith?.everyone === true
  },
  {
    id: 'ownerInactive',
    label: 'admin.userApps.filter.ownerInactive',
    matches: app => app.owner?.active === false
  },
  {
    id: 'ownerStale',
    label: 'admin.userApps.filter.ownerStale',
    matches: app => app.owner?.stale === true
  },
  // Shown only while an app has the clash: it should never happen.
  {
    id: 'clash',
    label: 'admin.userApps.filter.clash',
    matches: app => app.clash === true,
    onlyWhenFound: true
  }
];

/** What an app asks for, as the settings panel names it. */
const CAPABILITY_LABELS = {
  upload: 'admin.userApps.capability.upload',
  webSearch: 'userApps.edit.extras.webSearch',
  skills: 'userApps.edit.extras.skills',
  integrations: 'userApps.edit.extras.integrations'
};

/**
 * Whether an app was published and its company app is not switched on.
 *
 * @param {Object} app - A list item.
 * @returns {boolean}
 */
export function isWaiting(app) {
  return app?.state === 'promoted' && app.publishedAs?.enabled === false;
}

/**
 * A time span in words, as it stands in "Published {{age}} ago" and in
 * "Vor {{age}} veröffentlicht": "3 days", "5 hours", and in German the dative
 * "3 Tagen".
 *
 * @param {string} from - ISO date.
 * @param {number} now - Clock in milliseconds.
 * @param {string} language
 * @returns {string}
 *
 * @example
 * ageText('2026-11-19T10:00:00Z', Date.parse('2026-11-22T10:00:00Z'), 'en'); // → '3 days'
 * ageText('2026-11-19T10:00:00Z', Date.parse('2026-11-22T10:00:00Z'), 'de'); // → '3 Tagen'
 */
export function ageText(from, now, language) {
  const elapsed = Math.max(0, now - new Date(from).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  const [value, unit] =
    minutes >= 2880
      ? [Math.floor(minutes / 1440), 'day']
      : minutes >= 120
        ? [Math.floor(minutes / 60), 'hour']
        : [Math.max(1, minutes), 'minute'];
  try {
    if (String(language).startsWith('de')) {
      // German needs the dative after "vor": taken from "vor 3 Tagen".
      const parts = new Intl.RelativeTimeFormat('de', { numeric: 'always' }).formatToParts(
        -value,
        unit
      );
      const number = parts.findIndex(part => part.type === 'integer');
      if (number >= 0) return `${parts[number].value}${parts[number + 1]?.value || ''}`.trim();
    }
    return new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'long' }).format(
      value
    );
  } catch {
    return `${value} ${unit}`;
  }
}

/**
 * How many published apps wait to be switched on, for the label of the tab.
 * Null until known and when the list cannot be read.
 *
 * @param {boolean} enabled - Ask only for a full admin.
 * @returns {[number|null, (count: number) => void]} The count and its setter;
 *   the tab sets it after each load of its own.
 */
export function useWaitingUserAppCount(enabled) {
  const [count, setCount] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    fetchAdminUserApps({ waiting: true })
      .then(items => {
        if (active) setCount(items.length);
      })
      .catch(() => {
        // The label then carries no number.
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  return [count, setCount];
}

/**
 * The dialog "Switch off": the reason is shown to owner and members.
 *
 * @param {Object} props
 * @param {Object} props.app - The list item.
 * @param {() => void} props.onClose
 * @param {(view: Object) => void} props.onDone - Called with the admin view.
 */
function DisableDialog({ app, onClose, onDone }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await disableAdminUserApp(app.id, reason));
    } catch (err) {
      setError(apiErrorMessage(err, t, getAdminApiErrorMessage(err)));
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      isDirty={reason.trim() !== ''}
      labelledBy="user-app-disable-title"
    >
      <form onSubmit={submit} noValidate className="px-6 py-5 space-y-4">
        <h2
          id="user-app-disable-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('admin.userApps.disable.title', { name: app.name })}
        </h2>
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t('admin.userApps.disable.body')}
        </p>
        <div>
          <label
            htmlFor="user-app-disable-reason"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t('admin.userApps.disable.reason')}
          </label>
          <textarea
            id="user-app-disable-reason"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={event => setReason(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
            {t('admin.userApps.disable.action')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The dialog "Offer to a new owner". The admin picks a person; nothing changes
 * until that person accepts.
 *
 * @param {Object} props
 * @param {Object} props.app - The list item.
 * @param {() => void} props.onClose
 * @param {() => void} props.onDone - Called after the offer was stored.
 */
function OfferDialog({ app, onClose, onDone }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState([]);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      fetchUserAppOfferTargets(query.trim())
        .then(users => {
          if (active) setPeople(users.filter(person => person.id !== app.owner?.id));
        })
        .catch(err => {
          if (active) setError(apiErrorMessage(err, t, getAdminApiErrorMessage(err)));
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, app.owner?.id, t]);

  const submit = async event => {
    event.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      // The offer is made on the state the admin sees now: a newer one answers 409.
      const view = await fetchAdminUserApp(app.id);
      await offerAdminUserApp(app.id, picked.id, view.revision);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t, getAdminApiErrorMessage(err)));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} labelledBy="user-app-offer-title">
      <form onSubmit={submit} noValidate className="px-6 py-5 space-y-4">
        <h2
          id="user-app-offer-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('admin.userApps.offer.title', { name: app.name })}
        </h2>
        <p className="text-sm text-gray-700 dark:text-gray-300">{t('admin.userApps.offer.body')}</p>
        <div>
          <label
            htmlFor="user-app-offer-search"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t('admin.userApps.offer.search')}
          </label>
          <input
            id="user-app-offer-search"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <ul
          role="radiogroup"
          aria-labelledby="user-app-offer-title"
          className="max-h-56 overflow-y-auto space-y-1"
        >
          {people.map(person => (
            <li key={person.id}>
              <button
                type="button"
                role="radio"
                aria-checked={picked?.id === person.id}
                onClick={() => setPicked(person)}
                className="w-full rounded-md border border-gray-200 dark:border-gray-700 px-3 py-2 text-left text-sm text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700 aria-checked:border-indigo-500 aria-checked:bg-indigo-50 dark:aria-checked:bg-indigo-900/30"
              >
                {person.name}
                {person.email && (
                  <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                    {person.email}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={!picked || busy} className={PRIMARY_BUTTON_CLASS}>
            {picked
              ? t('userApps.transfer.submit', { owner: picked.name })
              : t('admin.userApps.offerOwner')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The dialog "Earlier versions": the stored content states, newest first,
 * each with who saved it and its instructions. Opening it is audited.
 *
 * @param {Object} props
 * @param {Object} props.app - The list item.
 * @param {() => void} props.onClose
 */
function RevisionsDialog({ app, onClose }) {
  const { t, i18n } = useTranslation();
  const [revisions, setRevisions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    fetchAdminUserAppRevisions(app.id)
      .then(items => {
        if (active) setRevisions(items);
      })
      .catch(err => {
        if (active) setError(getAdminApiErrorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [app.id]);

  const instructionsOf = content => {
    const system = content?.system;
    if (typeof system === 'string') return system;
    return Object.values(system || {})[0] || '';
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      labelledBy="user-app-revisions-title"
      maxWidthClassName="max-w-2xl"
    >
      <div className="px-6 py-5 space-y-4 overflow-y-auto">
        <h2
          id="user-app-revisions-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('admin.userApps.revisions')}: {app.name}
        </h2>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        {revisions && revisions.length === 0 && (
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t('admin.userApps.revision.empty')}
          </p>
        )}
        {revisions && revisions.length > 0 && (
          <ul className="space-y-2">
            {revisions.map(revision => (
              <li key={revision.revision}>
                <details className="rounded-md border border-gray-200 dark:border-gray-700">
                  <summary className="cursor-pointer px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                    {t('admin.userApps.revision.item', {
                      revision: revision.revision,
                      date: revision.savedAt
                        ? new Date(revision.savedAt).toLocaleString(i18n.language)
                        : '–',
                      name: revision.savedBy?.name || '–'
                    })}
                  </summary>
                  <div className="px-3 pb-3">
                    <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.userApps.revision.instructions')}
                    </p>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-gray-800 dark:text-gray-200">
                      {instructionsOf(revision.content)}
                    </pre>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The name of an app with the lines that say what is special about it: waiting
 * to be switched on, switched off, offered, owner inactive, ID clash.
 */
function AppCell({ app, now }) {
  const { t, i18n } = useTranslation();
  const notes = [];
  if (isWaiting(app)) {
    notes.push(
      t('admin.userApps.waiting.row', {
        age: app.publishedAs.at ? ageText(app.publishedAs.at, now, i18n.language) : '–'
      })
    );
  } else if (app.state === 'promoted') {
    notes.push(t('userApps.edit.state.promoted'));
  }
  // The personal app keeps working for these people until their groups get the company app.
  if (app.state === 'promoted' && app.membersWithoutCompanyApp > 0) {
    notes.push(
      t('admin.userApps.noAccess', {
        count: app.membersWithoutCompanyApp,
        total: app.sharedWith?.users || app.membersWithoutCompanyApp
      })
    );
  }
  if (app.disabled) {
    notes.push(
      app.disabled.reason
        ? `${t('userApps.edit.state.disabled')}: ${app.disabled.reason}`
        : t('userApps.edit.state.disabled')
    );
  }
  if (app.pendingOwner) {
    notes.push(t('userApps.edit.state.offered', { owner: app.pendingOwner.name }));
  }
  if (app.clash) notes.push(t('admin.userApps.clash'));

  return (
    <div className="flex items-start">
      <div
        className="h-10 w-10 shrink-0 rounded-full flex items-center justify-center text-white font-bold"
        style={{ backgroundColor: app.color || '#6B7280' }}
        aria-hidden="true"
      >
        {String(app.name || app.id)
          .charAt(0)
          .toUpperCase()}
      </div>
      <div className="ml-3 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{app.name}</div>
        {notes.map(note => (
          <div key={note} className="text-xs text-amber-800 dark:text-amber-300">
            {note}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The tab "Personal apps" of Admin → Apps: the settings of personal apps, and
 * every personal app with its owner, its shares and what it may use. A full
 * admin can open an app, switch it off, offer it to a new owner, read its
 * earlier versions and delete it. Shown to full admins whether or not the
 * feature is on, so everything can be set up first.
 *
 * @param {Object} props
 * @param {(count: number) => void} [props.onWaitingChange] - Told how many
 *   published apps wait to be switched on, after each load.
 * @returns {JSX.Element}
 */
function AdminUserAppsTab({ onWaitingChange }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const featureOn = useFeatureFlags().isEnabled('userApps', false);
  const [apps, setApps] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useFilterState('filter', 'all');
  const [ownerId, setOwnerId] = useFilterState('owner', '');
  const [dialog, setDialog] = useState(null);
  const { requestConfirm, dialogProps } = useConfirmAction();
  const [now] = useState(() => Date.now());
  const waitingChangedRef = useRef(onWaitingChange);
  waitingChangedRef.current = onWaitingChange;

  const load = useCallback(async () => {
    try {
      setError(null);
      const items = await fetchAdminUserApps();
      setApps(items);
      waitingChangedRef.current?.(items.filter(isWaiting).length);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setApps(previous => previous || []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const all = apps || [];
  const ofOwner = ownerId ? all.filter(app => app.owner?.id === ownerId) : all;
  const activeFilter = FILTERS.find(entry => entry.id === filter) || FILTERS[0];
  const needle = search.trim().toLowerCase();
  const shown = ofOwner.filter(
    app =>
      activeFilter.matches(app) &&
      (needle === '' ||
        String(app.name || '')
          .toLowerCase()
          .includes(needle) ||
        String(app.owner?.name || '')
          .toLowerCase()
          .includes(needle) ||
        app.id.toLowerCase().includes(needle))
  );
  const chips = FILTERS.map(entry => ({
    ...entry,
    count: ofOwner.filter(entry.matches).length
  })).filter(entry => !entry.onlyWhenFound || entry.count > 0 || entry.id === filter);

  const closeDialog = () => setDialog(null);
  const afterChange = async () => {
    setDialog(null);
    await load();
  };

  const run = async action => {
    setNotice(null);
    try {
      await action();
      await load();
    } catch (err) {
      setNotice(apiErrorMessage(err, t, getAdminApiErrorMessage(err)));
    }
  };

  const confirmDelete = app =>
    requestConfirm({
      ...deleteConfirmText({ typeKey: 'app', typeFallback: 'app', name: app.name, t }),
      action: async () => {
        await deleteAdminUserApp(app.id);
        await load();
      }
    });

  const confirmRelease = app =>
    requestConfirm({
      title: t('admin.userApps.release.title', { name: app.name }),
      message: t('admin.userApps.release.body', { owner: app.owner?.name || '' }),
      confirmLabel: t('admin.userApps.release.action'),
      errorMessage: err =>
        err?.response?.data?.details?.reason === 'published'
          ? t('admin.userApps.release.published')
          : apiErrorMessage(err, t, getAdminApiErrorMessage(err)),
      action: async () => {
        await releaseAdminUserApp(app.id);
        await load();
      }
    });

  const sharedWithText = app => {
    const shared = app.sharedWith || {};
    if (shared.everyone) return t('userApps.edit.state.everyone');
    const parts = [];
    if (shared.users > 0) parts.push(t('admin.userApps.shared.users', { count: shared.users }));
    if (shared.groups > 0) parts.push(t('admin.userApps.shared.groups', { count: shared.groups }));
    return parts.length > 0 ? parts.join(', ') : t('admin.userApps.shared.none');
  };

  const columns = [
    {
      key: 'app',
      header: t('admin.apps.table.app'),
      sortable: true,
      sortAccessor: app => String(app.name || ''),
      render: app => <AppCell app={app} now={now} />
    },
    {
      key: 'owner',
      header: t('admin.userApps.table.owner'),
      sortable: true,
      sortAccessor: app => String(app.owner?.name || ''),
      render: app => (
        <div className="text-sm text-gray-900 dark:text-gray-100">
          {app.owner?.name || '–'}
          {app.owner?.active === false && (
            <span className="block text-xs text-amber-800 dark:text-amber-300">
              {t('admin.userApps.filter.ownerInactive')}
            </span>
          )}
          {app.owner?.stale === true && (
            <span className="block text-xs text-amber-800 dark:text-amber-300">
              {t('admin.userApps.filter.ownerStale')}
            </span>
          )}
        </div>
      )
    },
    {
      key: 'sharedWith',
      header: t('admin.userApps.table.sharedWith'),
      hideBelow: 'md',
      render: app => (
        <span className="text-sm text-gray-700 dark:text-gray-300">{sharedWithText(app)}</span>
      )
    },
    {
      key: 'mayUse',
      header: t('admin.userApps.table.mayUse'),
      hideBelow: 'lg',
      render: app => (
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {(app.capabilities || [])
            .filter(name => CAPABILITY_LABELS[name])
            .map(name => t(CAPABILITY_LABELS[name]))
            .join(', ') || '–'}
        </span>
      )
    },
    {
      key: 'lastUsed',
      header: t('admin.userApps.table.lastUsed'),
      sortable: true,
      sortAccessor: app => app.lastUsedAt || '',
      hideBelow: 'md',
      render: app => (
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {app.lastUsedAt
            ? new Date(app.lastUsedAt).toLocaleDateString(i18n.language)
            : t('admin.users.view.never')}
        </span>
      )
    }
  ];

  const actions = [
    {
      // The chat of the app, in a new tab: a full admin may use every personal app.
      id: 'open',
      label: t('admin.apps.openApp'),
      icon: 'external-link',
      priority: 'primary',
      href: app => buildPath(`/apps/${encodeURIComponent(app.id)}`),
      target: '_blank',
      hidden: app => isWaiting(app)
    },
    {
      // The admin editor of the company app, where it is tested and published.
      id: 'openCompanyApp',
      label: t('admin.userApps.waiting.open'),
      icon: 'external-link',
      priority: 'primary',
      onClick: app => navigate(`/admin/apps/${encodeURIComponent(app.publishedAs.appId)}`),
      hidden: app => !isWaiting(app)
    },
    {
      id: 'takeOver',
      label: t('admin.userApps.takeOver.action'),
      icon: 'upload',
      onClick: app => setDialog({ kind: 'takeOver', app }),
      hidden: app => !TakeOverDialog || app.state === 'promoted'
    },
    {
      id: 'offer',
      label: t('admin.userApps.offerOwner'),
      icon: 'users',
      onClick: app => setDialog({ kind: 'offer', app }),
      // An offer goes through the routes of personal apps, which answer only while the feature
      // is on; nobody could accept it before that either.
      hidden: app => !featureOn || app.state === 'promoted' || Boolean(app.pendingOwner)
    },
    {
      id: 'withdrawOffer',
      label: t('userApps.transfer.withdraw'),
      icon: 'undo',
      onClick: app => run(() => withdrawAdminUserAppOffer(app.id)),
      hidden: app => !featureOn || !app.pendingOwner
    },
    {
      id: 'disable',
      label: t('admin.userApps.disable.action'),
      icon: 'ban',
      onClick: app => setDialog({ kind: 'disable', app }),
      hidden: app => Boolean(app.disabled)
    },
    {
      id: 'enable',
      label: t('admin.userApps.enable.action'),
      icon: 'eye',
      onClick: app => run(() => enableAdminUserApp(app.id)),
      hidden: app => !app.disabled
    },
    {
      id: 'revisions',
      label: t('admin.userApps.revisions'),
      icon: 'clock',
      onClick: app => setDialog({ kind: 'revisions', app })
    },
    {
      id: 'release',
      label: t('admin.userApps.release.action'),
      icon: 'undo',
      onClick: app => confirmRelease(app),
      hidden: app => app.state !== 'promoted'
    },
    {
      id: 'delete',
      label: t('common.delete'),
      icon: 'trash',
      destructive: true,
      onClick: app => confirmDelete(app)
    }
  ];

  const ownerName = ownerId
    ? all.find(app => app.owner?.id === ownerId)?.owner?.name || ownerId
    : '';

  return (
    <div>
      {!featureOn && (
        <p className={`${CALLOUT_CLASS.info} mb-4`}>
          {t('admin.userApps.featureOff')}{' '}
          <Link to="/admin/features" className="font-medium underline">
            {t('admin.nav.features')}
          </Link>
        </p>
      )}

      <UserAppSettingsPanel />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('admin.apps.searchPlaceholder')}
        />
        {ownerId && (
          <span className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            {t('admin.userApps.filter.owner', { name: ownerName })}
            <button
              type="button"
              onClick={() => setOwnerId('')}
              className="text-indigo-600 dark:text-indigo-400 underline"
            >
              {t('admin.userApps.filter.clearOwner')}
            </button>
          </span>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label={t('admin.userApps.filter.label')}
        className="mt-4 flex flex-wrap gap-2"
      >
        {chips.map(chip => (
          <button
            key={chip.id}
            type="button"
            role="radio"
            aria-checked={activeFilter.id === chip.id}
            onClick={() => setFilter(chip.id)}
            className="px-3 py-1.5 rounded-full text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 aria-checked:bg-gray-900 aria-checked:text-white dark:aria-checked:bg-gray-100 dark:aria-checked:text-gray-900"
          >
            {t(chip.label)} {apps ? chip.count : ''}
          </button>
        ))}
      </div>

      {error && <AdminLoadError message={error} framed={false} className="mt-4" action={null} />}
      {notice && (
        <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">
          {notice}
        </p>
      )}

      <div className="mt-6">
        <DataTable
          columns={columns}
          data={shown}
          getRowId={app => app.id}
          actions={actions}
          loading={apps === null}
          empty={{
            icon: 'sparkles',
            title: all.length === 0 ? t('admin.userApps.empty') : t('admin.userApps.noMatch')
          }}
        />
      </div>

      {dialog?.kind === 'disable' && (
        <DisableDialog app={dialog.app} onClose={closeDialog} onDone={afterChange} />
      )}
      {dialog?.kind === 'offer' && (
        <OfferDialog app={dialog.app} onClose={closeDialog} onDone={afterChange} />
      )}
      {dialog?.kind === 'revisions' && <RevisionsDialog app={dialog.app} onClose={closeDialog} />}
      {/* P12 MOUNT POINT (take-over dialog): rendered once `TakeOverDialog` above is set. */}
      {TakeOverDialog && dialog?.kind === 'takeOver' && (
        <TakeOverDialog
          app={dialog.app}
          onClose={closeDialog}
          onDone={newAppId => navigate(`/admin/apps/${encodeURIComponent(newAppId)}?created=1`)}
        />
      )}
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

export default AdminUserAppsTab;
