// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../../shared/components/ConfirmDialog';
import { audienceText } from './audienceText';

/**
 * The sentence (or two) that says who will see the app, or what stands in for
 * it while the page does not know.
 *
 * @param {object} props
 * @param {{loading?: boolean, failed?: boolean, view?: object|null}} props.access
 * @returns {JSX.Element}
 */
function Audience({ access }) {
  const { t } = useTranslation();
  const text = audienceText(access?.view);

  if (!text) {
    return (
      <p className="mt-1" data-testid="publish-audience">
        {access?.loading ? t('admin.contentAccess.loading') : t('admin.contentAccess.loadError')}
      </p>
    );
  }
  return (
    <p className="mt-1" data-testid="publish-audience" data-audience={text.kind}>
      {text.sentences.map(sentence => t(sentence.key, sentence.values)).join(' ')}
    </p>
  );
}

/**
 * Asks before an app is published and says who will see it.
 *
 * The audience comes from the content-access view, which the caller loads.
 * The dialog adds what else is true at this moment: unsaved changes are saved
 * first, and without a model users get no answer.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {string} props.name - The app's name, as the author reads it.
 * @param {{loading?: boolean, failed?: boolean, view?: object|null}} props.access -
 *   The content-access view of the app and how its load stands.
 * @param {boolean} [props.savesFirst=false] - The editor has unsaved changes.
 * @param {boolean} [props.noModel=false] - No AI model is available.
 * @param {boolean} [props.busy=false] - Saving or publishing is running.
 * @param {string|null} [props.error] - Why publishing failed.
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 * @returns {JSX.Element|null}
 */
function PublishDialog({
  isOpen,
  name,
  access,
  savesFirst = false,
  noModel = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel
}) {
  const { t } = useTranslation();
  const notes = [
    savesFirst && t('admin.apps.edit.publish.savesFirst'),
    noModel && t('admin.apps.edit.publish.noModel')
  ].filter(Boolean);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={t('admin.apps.edit.publish.title', { name })}
      message={
        <>
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.publish.who')}
          </h3>
          <Audience access={access} />
        </>
      }
      consequences={notes}
      confirmLabel={t('admin.apps.edit.publish.action')}
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onDeny={onCancel}
    />
  );
}

/**
 * Asks once before an app is unpublished. Unpublishing never saves the form.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {string} props.name - The app's name, as the author reads it.
 * @param {boolean} [props.busy=false]
 * @param {string|null} [props.error]
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 * @returns {JSX.Element|null}
 */
function UnpublishDialog({ isOpen, name, busy = false, error = null, onConfirm, onCancel }) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={t('admin.apps.edit.unpublish.title', { name })}
      message={t('admin.apps.edit.unpublish.body')}
      confirmLabel={t('admin.apps.edit.unpublish.action')}
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onDeny={onCancel}
    />
  );
}

/**
 * The two questions of the editor's header, "Publish?" and "Unpublish?", for
 * the state that `useAppPublishing` holds. At most one is open.
 *
 * @param {object} props
 * @param {{dialog: 'publish'|'unpublish'|null, busy: boolean, error: string|null,
 *   confirm: () => void, cancel: () => void}} props.publishing - From `useAppPublishing`.
 * @param {string} props.name - The app's name, as the author reads it.
 * @param {{loading?: boolean, failed?: boolean, view?: object|null}} props.access
 * @param {boolean} [props.savesFirst=false] - The editor has unsaved changes.
 * @param {boolean} [props.noModel=false] - No AI model is available.
 * @returns {JSX.Element}
 */
export function PublishDialogs({ publishing, name, access, savesFirst = false, noModel = false }) {
  const shared = {
    name,
    busy: publishing.busy,
    error: publishing.error,
    onConfirm: publishing.confirm,
    onCancel: publishing.cancel
  };
  return (
    <>
      <PublishDialog
        isOpen={publishing.dialog === 'publish'}
        access={access}
        savesFirst={savesFirst}
        noModel={noModel}
        {...shared}
      />
      <UnpublishDialog isOpen={publishing.dialog === 'unpublish'} {...shared} />
    </>
  );
}

export default PublishDialog;
