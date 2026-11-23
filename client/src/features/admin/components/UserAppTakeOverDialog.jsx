// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchAdminUserApp,
  getAdminApiErrorMessage,
  makeAdminApiCall
} from '../../../api/adminApi';
import Modal from '../../../shared/components/Modal';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { capabilityLines, droppedText } from '../../apps/components/user-app/publishText';
import { appCategoryOptions } from '../utils/appDraft';
import { idError } from './app-create/createErrors';
import {
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from './formStyles';

const TITLE_ID = 'user-app-take-over-title';
const ID_FIELD = 'user-app-take-over-id';
const CATEGORY_FIELD = 'user-app-take-over-category';

/**
 * "Take over as app": a full admin makes a company app from a personal app
 * without its owner.
 *
 * The dialog reads the admin view of the app, for `takeOverPreview` (what the
 * server would write: every connected system with every function by name,
 * every skill by ID, and what is left behind and why) and for the revision
 * the take-over is made on. The admin may change the suggested ID and pick a
 * category. The new app is always created "Not published".
 *
 * @param {Object} props
 * @param {Object} props.app - The list item of `GET /api/admin/user-apps`.
 * @param {() => void} props.onClose
 * @param {(newAppId: string) => void} props.onDone - Called with the ID of
 *   the new admin app after the server created it.
 * @param {() => void} [props.onStale] - Called when the app changed since the
 *   list was read (it was published meanwhile, or changed while the dialog was
 *   open), so the list can be read again.
 * @returns {JSX.Element}
 */
function UserAppTakeOverDialog({ app, onClose, onDone, onStale }) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState(null);
  const [categories, setCategories] = useState([]);
  const [id, setId] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [idMessage, setIdMessage] = useState(null);

  /**
   * Takes a freshly read admin view. Without a preview the dialog cannot go
   * on: the app was published meanwhile, or the server could not work out
   * what a take-over would write. Either way it says so instead of loading on.
   *
   * @returns {boolean} Whether the view carries a preview.
   */
  const adopt = loaded => {
    setView(loaded);
    if (loaded?.takeOverPreview) return true;
    setError(
      t(
        loaded?.state === 'promoted'
          ? 'admin.userApps.takeOver.alreadyPublished'
          : 'admin.userApps.takeOver.unavailable'
      )
    );
    if (loaded?.state === 'promoted') onStale?.();
    return false;
  };

  useEffect(() => {
    let active = true;
    fetchAdminUserApp(app.id)
      .then(loaded => {
        if (!active) return;
        if (adopt(loaded)) setId(loaded.takeOverPreview.suggestedId || '');
      })
      .catch(err => {
        if (active) setError(apiErrorMessage(err, t, getAdminApiErrorMessage(err)));
      });
    // The categories are a convenience: without them the app gets none.
    Promise.resolve()
      .then(() => makeAdminApiCall('/admin/ui/config'))
      .then(response => {
        if (active) setCategories(appCategoryOptions(response?.data));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // `adopt` is a new function on each render; the app is read once per app.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [app.id, t]);

  const preview = view?.takeOverPreview;
  const lines = capabilityLines(preview?.capabilities, t);
  const dropped = droppedText(preview?.dropped, t);
  // Who uses the personal app today: people named directly, groups, and everyone.
  const users = view?.sharedWith?.users || 0;
  const groups = view?.sharedWith?.groups || 0;
  const everyone = view?.sharedWith?.everyone === true;
  const ownerName = app.owner?.name || app.owner?.id || '';

  const submit = async event => {
    event.preventDefault();
    if (!preview || busy) return;
    const problem = idError(id, { name: app.name });
    if (problem) {
      setIdMessage(t(problem.key, problem.values));
      return;
    }
    setBusy(true);
    setError(null);
    setIdMessage(null);
    try {
      const response = await makeAdminApiCall(
        `/admin/user-apps/${encodeURIComponent(app.id)}/_promote`,
        {
          method: 'POST',
          body: { id, ...(category ? { category } : {}) },
          headers: { 'If-Match': `"${view.revision}"` }
        }
      );
      onDone(response?.data?.id || id);
    } catch (err) {
      const problemBody = err?.response?.data;
      if (problemBody?.details?.reason === 'idTaken') {
        setIdMessage(t('admin.apps.create.error.idTaken', { id }));
      } else if (problemBody?.code === 'ETAG_MISMATCH') {
        // Read the app again: the preview then shows the new state, and the
        // next "Take over" is made on its revision instead of failing again.
        onStale?.();
        try {
          if (adopt(await fetchAdminUserApp(app.id))) setError(t('admin.userApps.changed'));
        } catch (reloadError) {
          setError(apiErrorMessage(reloadError, t, getAdminApiErrorMessage(reloadError)));
        }
      } else {
        setError(apiErrorMessage(err, t, getAdminApiErrorMessage(err)));
      }
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} labelledBy={TITLE_ID}>
      <form
        onSubmit={submit}
        noValidate
        className="space-y-4 px-6 py-5"
        data-testid="user-app-take-over"
      >
        <h2 id={TITLE_ID} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.userApps.takeOver.title', { name: app.name })}
        </h2>

        {preview && (
          <>
            <div>
              <label htmlFor={ID_FIELD} className={LABEL_CLASS}>
                {t('admin.apps.create.essentials.id')}
              </label>
              <input
                id={ID_FIELD}
                type="text"
                value={id}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={idMessage ? 'true' : undefined}
                aria-describedby={idMessage ? `${ID_FIELD}-error` : undefined}
                onChange={event => {
                  setId(event.target.value);
                  setIdMessage(null);
                }}
                className={MONO_INPUT_CLASS}
              />
              {idMessage && (
                <p
                  id={`${ID_FIELD}-error`}
                  role="alert"
                  className="mt-1 text-sm text-red-700 dark:text-red-300"
                >
                  {idMessage}
                </p>
              )}
            </div>
            {categories.length > 0 && (
              <div>
                <label htmlFor={CATEGORY_FIELD} className={LABEL_CLASS}>
                  {t('admin.apps.create.essentials.category')}
                </label>
                <select
                  id={CATEGORY_FIELD}
                  value={category}
                  onChange={event => setCategory(event.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">{t('admin.userApps.takeOver.noCategory')}</option>
                  {categories.map(option => (
                    <option key={option.id} value={option.id}>
                      {getLocalizedContent(option.name, i18n.language) || option.id}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="text-sm text-gray-700 dark:text-gray-300">
              <p className="font-medium">{t('admin.userApps.takeOver.willUse')}</p>
              <ul className="mt-1 list-disc space-y-1 pl-5" data-testid="user-app-take-over-can">
                {lines.map(line => (
                  <li key={line.id}>{line.text}</li>
                ))}
              </ul>
              {dropped && (
                <p className="mt-2" data-testid="user-app-take-over-dropped">
                  {t('admin.userApps.takeOver.dropped', { list: dropped })}
                </p>
              )}
              {preview.plain === true && (
                <p className="mt-2">{t('admin.userApps.takeOver.plain')}</p>
              )}
              <ul className="mt-3 list-disc space-y-1 pl-5">
                <li>{t('admin.userApps.takeOver.notPublished')}</li>
                {ownerName && <li>{t('admin.userApps.takeOver.owner', { owner: ownerName })}</li>}
                {users > 0 && <li>{t('admin.userApps.takeOver.users', { count: users })}</li>}
                {groups > 0 && <li>{t('admin.userApps.takeOver.groups', { count: groups })}</li>}
                {everyone && <li>{t('admin.userApps.takeOver.everyone')}</li>}
              </ul>
            </div>
          </>
        )}
        {!preview && !error && <p className={HELP_CLASS}>{t('common.loading')}</p>}

        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={!preview || busy} className={PRIMARY_BUTTON_CLASS}>
            {t('admin.userApps.takeOver.submit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default UserAppTakeOverDialog;
