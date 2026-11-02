// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../../shared/components/Icon';
import { Link } from 'react-router-dom';
import IntegrationTestResults from '../../IntegrationTestResults';
import ActionToggleList from '../ActionToggleList';
import {
  CALLOUT_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../../formStyles';

/**
 * Building blocks of the dedicated installation editors (iFinder,
 * iAssistant, and those that follow): a section card, the name, who may use
 * it, the actions and the footer with Test, Cancel and Save. They read and
 * write the state of `useInstallationEditor`.
 */

/**
 * A titled card of an editor.
 *
 * @param {Object} props
 * @param {string} props.id - base id; the heading gets `${id}-title`
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {React.ReactNode} props.children
 */
export function EditorSection({ id, title, description, children }) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5 space-y-4"
    >
      <div>
        <h3 id={`${id}-title`} className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h3>
        {description && (
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Label and description of the installation, in the admin's language.
 *
 * @param {Object} props
 * @param {Object} props.editor - `useInstallationEditor` state
 * @param {Object} props.definition - for the label placeholder
 * @param {string} props.idPrefix
 */
export function NameSection({ editor, definition, idPrefix }) {
  const { t } = useTranslation();
  return (
    <EditorSection
      id={`${idPrefix}-name`}
      title={t('admin.integrations.editors.nameSection', 'Name')}
      description={t(
        'admin.integrations.editors.nameSectionHelp',
        'How users see this integration in the chat. The id stays fixed.'
      )}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor={`${idPrefix}-label`} className={LABEL_CLASS}>
            {t('admin.integrationCatalog.wizard.label', 'Label')}
          </label>
          <input
            id={`${idPrefix}-label`}
            className={INPUT_CLASS}
            value={editor.label}
            onChange={e => editor.setLabel(e.target.value)}
            placeholder={definition?.name}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-description`} className={LABEL_CLASS}>
            {t('admin.integrationCatalog.wizard.description', 'Description')}
          </label>
          <input
            id={`${idPrefix}-description`}
            className={INPUT_CLASS}
            value={editor.description}
            onChange={e => editor.setDescription(e.target.value)}
          />
        </div>
      </div>
    </EditorSection>
  );
}

/**
 * Who may use the installation: the groups that grant it, granted on the
 * group page (`permissions.integrations`, #3093), with a link there.
 *
 * @param {Object} props
 * @param {Object} props.editor
 * @param {string} props.idPrefix
 */
export function AccessSection({ editor, idPrefix }) {
  const { t } = useTranslation();
  return (
    <EditorSection
      id={`${idPrefix}-access`}
      title={t('admin.integrations.editors.accessSection', 'Who may use it')}
    >
      <GrantedGroups grantedTo={editor.grantedTo} />
    </EditorSection>
  );
}

/**
 * The groups that grant an installation, or a hint that none does, and the
 * link to the group page where grants are edited.
 *
 * @param {Object} props
 * @param {string[]|null} props.grantedTo - null while unknown
 */
export function GrantedGroups({ grantedTo }) {
  const { t } = useTranslation();
  return (
    <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
      {Array.isArray(grantedTo) && (
        <p data-testid="granted-groups">
          {grantedTo.length > 0
            ? t('admin.integrations.access.grantedTo', 'Granted to: {{groups}}', {
                groups: grantedTo.join(', ')
              })
            : t('admin.integrations.access.noGroup', 'No group grants it yet: nobody can use it.')}
        </p>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t(
          'admin.integrations.access.help',
          'Groups decide which integrations their members may use (inherited like apps).'
        )}{' '}
        <Link to="/admin/groups" className="text-indigo-700 dark:text-indigo-300 hover:underline">
          {t('admin.integrations.access.editOnGroups', 'Edit on Admin → Groups')}
        </Link>
      </p>
    </div>
  );
}

/**
 * The actions the model may call; nothing when the definition has none.
 *
 * @param {Object} props
 * @param {Object} props.editor
 * @param {Object} props.definition
 * @param {Object} props.instance - for the auth mode and the stored policy
 * @param {string} props.idPrefix
 */
export function ActionsSection({ editor, definition, instance, idPrefix }) {
  const { t } = useTranslation();
  if (editor.knownActions.length === 0 && !definition?.dynamicActions) return null;
  return (
    <EditorSection
      id={`${idPrefix}-actions`}
      title={t('admin.integrations.editors.actionsSection', 'Actions the model may call')}
      description={t(
        'admin.integrations.editors.actionsSectionHelp',
        'An app that binds this integration offers the checked actions; it can narrow them further.'
      )}
    >
      <ActionToggleList
        actions={editor.knownActions}
        checked={editor.checkedActions}
        onToggle={editor.toggleAction}
        authMode={instance.auth?.mode || 'none'}
        dynamicActions={Boolean(definition?.dynamicActions)}
        storedPolicy={instance.actions || null}
        idPrefix={`${idPrefix}-action`}
      />
    </EditorSection>
  );
}

/**
 * The error, the test results and the buttons of an editor. Save submits the
 * editor's form (`formId`).
 *
 * @param {Object} props
 * @param {Object} props.editor
 * @param {string} props.formId - the `<form>` Save submits
 * @param {() => void} props.onTest - test the unsaved values
 * @param {() => void} props.onCancel
 * @param {string} [props.testHelp] - what the test does, shown next to the button
 * @param {string} [props.testTitle] - heading of the test results
 */
export function EditorFooter({ editor, formId, onTest, onCancel, testHelp, testTitle }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {editor.error && (
        <div className={CALLOUT_CLASS.danger} role="alert">
          {editor.error}
        </div>
      )}
      {editor.testResult && (
        <IntegrationTestResults
          title={testTitle || t('admin.integrationCatalog.wizard.testResults', 'Test results')}
          result={editor.testResult}
        />
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-[240px]">
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={onTest}
            disabled={editor.testing || editor.saving}
          >
            <Icon name="play" size="sm" />
            {editor.testing
              ? t('admin.integrationCatalog.wizard.testing', 'Testing…')
              : t('admin.integrationCatalog.wizard.test', 'Test connection')}
          </button>
          {testHelp && <p className={`${HELP_CLASS} max-w-xl`}>{testHelp}</p>}
        </div>
        <div className="flex gap-2">
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={PRIMARY_BUTTON_CLASS}
            disabled={editor.saving || editor.testing}
          >
            <Icon name="save" size="sm" />
            {editor.saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * An error the server or the editor's own checks reported for one field. The
 * footer announces the error; this repeats it next to the field (referenced
 * by the field's `aria-describedby` through `id`).
 *
 * @param {Object} props
 * @param {string} [props.id]
 * @param {string} [props.message]
 */
export function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-xs text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}
