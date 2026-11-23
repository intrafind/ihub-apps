// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { publishUserApp } from '../../../../api';
import ConfirmDialog from '../../../../shared/components/ConfirmDialog';
import { capabilityLines, droppedText, toolsText } from './publishText';
import { userAppErrorCode, userAppErrorMessage } from './userAppErrors';

/**
 * The owner's "Publish": the personal app becomes a company app that
 * administrators manage.
 *
 * The dialog has two forms, and the server says which one applies
 * (`app.publish.startsEnabled`): the company app is visible at once, or an
 * administrator switches it on first. The list of what the company app will
 * be able to do and of what is left behind is `app.publish` as the server
 * computed it; the dialog decides nothing.
 *
 * "Publish" sends the revision the page loaded. When someone changed the app
 * meanwhile the server refuses, and the dialog hands over to `onChanged`.
 *
 * @param {object} props
 * @param {object} props.app - The app as the server answered it to its owner
 *   (`id`, `revision`, `publish`).
 * @param {string} props.name - The name of the app in the reader's language.
 * @param {() => void} props.onClose
 * @param {(app: object) => void} props.onPublished - Gets the answer of the
 *   publish: the app, now with the administrators.
 * @param {() => void} [props.onChanged] - The app was changed by someone else
 *   since the page loaded it; nothing was published.
 * @returns {JSX.Element}
 */
function PublishDialog({ app, name, onClose, onPublished, onChanged }) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const preview = app?.publish || {};
  const now = preview.startsEnabled === true;
  const lines = capabilityLines(preview.capabilities, t);
  const dropped = droppedText(preview.dropped, t, { asOwner: true });

  let body;
  if (now) body = t('userApps.publish.bodyNow');
  else if (preview.waitsFor === 'tools') {
    body = t('userApps.publish.bodyLaterTools', {
      list: toolsText(preview.tools, t, i18n.language)
    });
  } else body = t('userApps.publish.bodyLaterAlways');

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      onPublished(await publishUserApp(app.id, { revision: app.revision }));
    } catch (failure) {
      if (userAppErrorCode(failure) === 'ETAG_MISMATCH' && onChanged) {
        onChanged();
        return;
      }
      setError(userAppErrorMessage(failure, t));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      isOpen
      title={t(now ? 'userApps.publish.titleNow' : 'userApps.publish.titleLater', { name })}
      message={
        <div data-testid="user-app-publish" data-form={now ? 'now' : 'later'}>
          <p>{body}</p>
          <p className="mt-3 font-medium">{t('userApps.publish.willUse')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5" data-testid="user-app-publish-can">
            {lines.map(line => (
              <li key={line.id}>{line.text}</li>
            ))}
          </ul>
          {dropped && (
            <p className="mt-2" data-testid="user-app-publish-dropped">
              {t('userApps.publish.dropped', { list: dropped })}
            </p>
          )}
          {preview.plain === true && <p className="mt-2">{t('userApps.publish.plain')}</p>}
        </div>
      }
      consequences={[
        t('userApps.publish.managed'),
        t(now ? 'userApps.publish.membersNow' : 'userApps.publish.membersLater')
      ]}
      confirmLabel={t('userApps.publish.submit')}
      busy={busy}
      error={error}
      onConfirm={publish}
      onDeny={onClose}
    />
  );
}

export default PublishDialog;
