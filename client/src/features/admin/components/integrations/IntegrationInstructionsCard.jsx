// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';
import { saveIntegrationInstructions } from '../../../../api/integrationsAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import { CALLOUT_CLASS, HELP_CLASS, INPUT_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';

/**
 * Where the integration's instructions come from, as the admin reads it.
 * @param {Function} t
 * @param {string|null} source - `admin`, `definition`, `server` or null
 * @returns {string}
 */
function instructionsSourceLabel(t, source) {
  switch (source) {
    case 'admin':
      return t('admin.integrations.instructions.sourceAdmin', 'Your text');
    case 'definition':
      return t(
        'admin.integrations.instructions.sourceDefinition',
        'From the integration definition'
      );
    case 'server':
      return t('admin.integrations.instructions.sourceServer', 'Sent by the server');
    default:
      return '';
  }
}

/**
 * The integration-level model guidance on the installation's Overview
 * (#2974): the MCP server's `instructions` or the connector's guidance, which
 * iHub adds to the system prompt while the integration is active in a chat.
 * The admin can replace it for the current language or go back to the
 * definition's.
 *
 * The text being edited belongs to the page, not to this card: the Overview unmounts when
 * another tab is shown, and the page's one save bar saves and discards the edit together with
 * the settings and the approval. Going back to the integration's own text acts at once, like
 * the other single actions of the page.
 *
 * @param {Object} props
 * @param {string} props.instanceId
 * @param {{text: string, source: string|null, own: Object|string|null}} props.instructions
 * @param {boolean} [props.disabled] - the installation cannot be changed now
 * @param {string|null} props.draft - The text being edited; null while the card only shows it
 * @param {(text: string) => void} props.onDraftChange
 * @param {() => void} props.onEdit - Start editing, from the text shown now
 * @param {() => void} props.onCancel - Leave editing and drop the draft
 * @param {boolean} [props.saving] - The page's save is running
 * @param {() => Promise<void>|void} props.onSaved - reload after going back to the own text
 * @returns {JSX.Element}
 */
function IntegrationInstructionsCard({
  instanceId,
  instructions,
  disabled = false,
  draft,
  onDraftChange,
  onEdit,
  onCancel,
  saving = false,
  onSaved
}) {
  const { t } = useTranslation();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const current = instructions || { text: '', source: null, own: null };
  // The draft is the text being edited; null while the card only shows the stored one.
  const editing = typeof draft === 'string';

  const restoreOwn = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveIntegrationInstructions(instanceId, null);
      await onSaved?.();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-5"
      aria-labelledby={`${id}-title`}
      data-testid="installation-instructions"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 id={`${id}-title`} className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.integrations.instructions.title', 'Instructions for the model')}
        </h2>
        {current.source && (
          <Badge tone={current.source === 'admin' ? 'accent' : 'neutral'} shape="rounded">
            {instructionsSourceLabel(t, current.source)}
          </Badge>
        )}
      </div>
      <p id={`${id}-help`} className="mb-2 text-sm text-gray-600 dark:text-gray-400">
        {t(
          'admin.integrations.instructions.help',
          'Added to the system prompt while this integration is active in a chat, together with the guidance of each action it offers.'
        )}
      </p>
      {error && <p className={`mb-2 ${CALLOUT_CLASS.danger}`}>{error}</p>}
      {editing ? (
        <div>
          <label htmlFor={`${id}-text`} className="sr-only">
            {t('admin.integrations.instructions.title', 'Instructions for the model')}
          </label>
          {/* A textarea: Enter is a new line here, and nothing around it submits. */}
          <textarea
            id={`${id}-text`}
            className={INPUT_CLASS}
            rows={5}
            value={draft}
            disabled={saving}
            aria-describedby={`${id}-help`}
            onChange={e => onDraftChange(e.target.value)}
          />
          <p className={HELP_CLASS}>
            {t(
              'admin.integrations.instructions.languageHint',
              'Saved for the current language; an empty text uses the integration’s own again.'
            )}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              disabled={saving}
              onClick={onCancel}
            >
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {current.text ? (
            <p className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">
              {current.text}
            </p>
          ) : (
            <p className="text-sm italic text-gray-600 dark:text-gray-400">
              {t('admin.integrations.instructions.none', 'No instructions.')}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              disabled={disabled || busy || saving}
              onClick={onEdit}
            >
              <Icon name="pencil" size="sm" />
              {t('admin.integrations.instructions.edit', 'Edit instructions')}
            </button>
            {current.own && (
              <button
                type="button"
                className={SECONDARY_BUTTON_CLASS}
                disabled={disabled || busy || saving}
                onClick={() => void restoreOwn()}
              >
                {t('admin.integrations.instructions.reset', 'Use the integration’s own')}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default IntegrationInstructionsCard;
