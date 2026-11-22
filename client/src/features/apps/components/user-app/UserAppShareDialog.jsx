// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchUserAppShareTargets, setUserAppMembers } from '../../../../api';
import { buildPath } from '../../../../utils/runtimeBasePath';
import PromptShareDialog from '../../../prompts/components/PromptShareDialog';
import { userAppErrorMessage } from './userAppErrors';
import { membersToShares, sharesToMembers } from './userAppForm';

const LINK_BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700';

/**
 * The address of the chat of an app, as a colleague opens it: the origin of
 * this window plus the path under the base path of the installation.
 *
 * @param {string} appId
 * @returns {string}
 *
 * @example
 * userAppLink('uap_3f9c…'); // → 'https://ihub.example/ihub/apps/uap_3f9c…'
 */
export function userAppLink(appId) {
  const path = buildPath(`/apps/${encodeURIComponent(appId)}`);
  return new URL(path, window.location.origin).href;
}

/** The share targets as the share dialog reads them. */
const loadTargets = async query => {
  const targets = await fetchUserAppShareTargets({ q: query });
  return {
    // The audiences the settings allow. An answer without `allowed` lists only
    // the allowed kinds, so the search stays and finds nothing for the others.
    allowed: {
      user: targets.allowed?.user ?? true,
      group: targets.allowed?.group ?? true,
      everyone: targets.everyone === true
    },
    users: targets.users,
    groups: targets.groups
  };
};

/**
 * Saves the shares of the dialog as the member list of the app, on the
 * revision the dialog was opened with: a member list someone else changed in
 * the meantime is not overwritten (409 `ETAG_MISMATCH`).
 */
const saveMembersOf = app => (appId, shares) =>
  setUserAppMembers(appId, sharesToMembers(shares), { revision: app.revision });

/**
 * "Copy link" with its confirmation. Nobody is notified when an app is shared
 * with them, so the link is how the owner tells colleagues; it opens the app
 * only for people who may use it.
 *
 * @param {object} props
 * @param {string} props.appId
 * @returns {JSX.Element}
 */
function CopyLinkButton({ appId }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(userAppLink(appId));
      setCopied(true);
    } catch {
      // Without clipboard access nothing was copied, and nothing says it was.
      setCopied(false);
    }
  }, [appId]);
  return (
    <span className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" onClick={copy} className={LINK_BUTTON_CLASS}>
        {t('userApps.share.copyLink')}
      </button>
      <span role="status">{copied ? t('userApps.share.linkCopied') : ''}</span>
    </span>
  );
}

/**
 * Who a personal app is shared with: the share dialog of the prompt library
 * with the calls and texts of personal apps. People, groups and, where the
 * settings allow it, everyone signed in, each as "Can use" or "Can edit". The
 * list replaces the stored one on save.
 *
 * Mount it only while open, and only for an app whose member list the caller
 * may read (owner, "Can edit").
 *
 * @param {object} props
 * @param {object} props.app - The app as the server answered it (`id`, `members`).
 * @param {string} props.name - The name of the app in the reader's language.
 * @param {() => void} props.onClose
 * @param {(app: object) => void} props.onSaved - The app after the member change.
 * @returns {JSX.Element}
 */
function UserAppShareDialog({ app, name, onClose, onSaved }) {
  const { t } = useTranslation();
  return (
    <PromptShareDialog
      // The title names the app; the line under it would repeat the name.
      prompt={{ id: app.id, name: '', shares: membersToShares(app.members) }}
      onClose={onClose}
      onSaved={onSaved}
      fetchTargets={loadTargets}
      saveShares={saveMembersOf(app)}
      errorMessage={userAppErrorMessage}
      labels={{
        title: t('userApps.share.title', { name }),
        private: t('userApps.share.private'),
        // The names of the two roles and of "everyone" as personal apps use them everywhere.
        canUse: t('userApps.share.role.user'),
        canEdit: t('userApps.share.role.editor'),
        everyone: t('userApps.share.everyone'),
        help: (
          <>
            {t('userApps.share.help')}
            <CopyLinkButton appId={app.id} />
          </>
        )
      }}
    />
  );
}

export default UserAppShareDialog;
