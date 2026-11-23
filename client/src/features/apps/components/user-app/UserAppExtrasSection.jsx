// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../../../admin/components/formStyles';
import { WITHHELD_MODEL, stillAsksFor } from './userAppForm';

/** The names of the actions an installation offers personal apps, as strings. */
const actionNames = system =>
  (Array.isArray(system?.actions) ? system.actions : [])
    .map(action => (typeof action === 'string' ? action : action?.name))
    .filter(Boolean);

/**
 * One switch with its label and an optional line under it.
 *
 * @param {object} props
 * @param {boolean} props.checked
 * @param {(checked: boolean) => void} props.onChange
 * @param {string} props.label
 * @param {string} [props.help]
 * @returns {JSX.Element}
 */
function Switch({ checked, onChange, label, help }) {
  const id = useId();
  return (
    <div>
      <div className="flex items-center">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={event => onChange(event.target.checked)}
          aria-describedby={help ? `${id}-help` : undefined}
          className={CHECKBOX_CLASS}
        />
        <label htmlFor={id} className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
          {label}
        </label>
      </div>
      {help && (
        <p id={`${id}-help`} className={`${HELP_CLASS} ml-6`}>
          {help}
        </p>
      )}
    </div>
  );
}

/**
 * "What the app may use": the preferred AI model and the switches for files,
 * web search, skills and connected systems.
 *
 * Only what the installation allows the caller in an app of their own is
 * offered (`capabilities` of `GET /api/apps/_config`); a capability that is
 * off there is not shown at all, and a connected system lists only the
 * actions an administrator allowed. The exception is a capability the app
 * still asks for and no longer gets: it stays visible with a note and the
 * button "Remove", because the app cannot be saved with it.
 *
 * @param {object} props
 * @param {object} props.form - The form state (`userAppForm.js`).
 * @param {(form: object) => void} props.onChange - Receives the changed form state.
 * @param {{modelChoice?: boolean, upload?: boolean, webSearch?: boolean, skills?: boolean,
 *   integrations?: Array<{id: string, label?: string, actions?: Array<string|{name: string,
 *   description?: string}>}>}|null} props.allowed - What may be offered; nothing without it.
 * @param {Array<{id: string, name?: object|string}>} [props.models] - The models the caller
 *   may choose.
 * @param {Array<{id: string, kind: string, installationId: string|null}>} [props.withheld] -
 *   The result of `withheldCapabilities(app)`.
 * @param {(capability: object) => string} props.capabilityName - A capability's name for a sentence.
 * @param {(capability: object) => void} props.onRemove - "Remove" of a withheld capability.
 * @param {string} [props.language] - The reader's language, for model names.
 * @returns {JSX.Element}
 */
function UserAppExtrasSection({
  form,
  onChange,
  allowed,
  models = [],
  withheld = [],
  capabilityName,
  onRemove,
  language
}) {
  const { t } = useTranslation();
  const modelId = useId();
  const may = allowed || {};
  const capabilities = form.capabilities;
  const setFlag = (flag, value) =>
    onChange({ ...form, capabilities: { ...capabilities, [flag]: value } });
  const setIntegrations = integrations =>
    onChange({ ...form, capabilities: { ...capabilities, integrations } });

  const gone = withheld.filter(capability => stillAsksFor(form, capability));
  const isGone = kind => gone.some(capability => capability.kind === kind);
  const goneSystems = new Set(
    gone.filter(capability => capability.kind === 'integration').map(c => c.installationId)
  );
  const systems = (Array.isArray(may.integrations) ? may.integrations : []).filter(
    system => typeof system?.id === 'string' && !goneSystems.has(system.id)
  );
  const bindingOf = id => capabilities.integrations.find(binding => binding.id === id);

  const toggleSystem = (system, checked) =>
    setIntegrations(
      checked
        ? [
            ...capabilities.integrations.filter(binding => binding.id !== system.id),
            { id: system.id, actions: actionNames(system) }
          ]
        : capabilities.integrations.filter(binding => binding.id !== system.id)
    );
  const toggleAction = (system, action, checked) => {
    const binding = bindingOf(system.id);
    const actions = checked
      ? actionNames(system).filter(name => name === action || binding.actions.includes(name))
      : binding.actions.filter(name => name !== action);
    // A binding names its actions; without one the system is not bound.
    setIntegrations(
      actions.length === 0
        ? capabilities.integrations.filter(entry => entry.id !== system.id)
        : capabilities.integrations.map(entry =>
            entry.id === system.id ? { ...entry, actions } : entry
          )
    );
  };

  const chosenModel = form.preferredModel === WITHHELD_MODEL ? '' : form.preferredModel || '';
  const modelOptions =
    chosenModel && !models.some(model => model.id === chosenModel)
      ? [...models, { id: chosenModel, name: chosenModel }]
      : models;

  const showModel = may.modelChoice === true && !isGone('model');
  const showUpload = may.upload === true && !isGone('upload');
  const showWebSearch = may.webSearch === true && !isGone('webSearch');
  const showSkills = may.skills === true && !isGone('skills');
  const nothing =
    !showModel &&
    !showUpload &&
    !showWebSearch &&
    !showSkills &&
    systems.length === 0 &&
    gone.length === 0;

  return (
    <div
      data-testid="user-app-extras"
      className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6 space-y-5"
    >
      {gone.map(capability => (
        <div
          key={capability.id}
          data-testid="user-app-gone"
          className={`flex flex-wrap items-center justify-between gap-3 ${CALLOUT_CLASS.warning}`}
        >
          <p>{t('userApps.edit.extras.gone', { capability: capabilityName(capability) })}</p>
          <button
            type="button"
            onClick={() => onRemove(capability)}
            aria-label={`${t('userApps.edit.extras.remove')}: ${capabilityName(capability)}`}
            className={SECONDARY_BUTTON_CLASS}
          >
            {t('userApps.edit.extras.remove')}
          </button>
        </div>
      ))}

      {showModel && (
        <div>
          <label htmlFor={modelId} className={LABEL_CLASS}>
            {t('userApps.edit.extras.model')}
          </label>
          <select
            id={modelId}
            value={chosenModel}
            onChange={event => onChange({ ...form, preferredModel: event.target.value || null })}
            className={INPUT_CLASS}
          >
            <option value="">{t('admin.apps.edit.standardModel')}</option>
            {modelOptions.map(model => (
              <option key={model.id} value={model.id}>
                {getLocalizedContent(model.name, language) || model.id}
              </option>
            ))}
          </select>
        </div>
      )}

      {showUpload && (
        <Switch
          checked={capabilities.upload === true}
          onChange={value => setFlag('upload', value)}
          label={t('userApps.edit.extras.upload')}
        />
      )}
      {showWebSearch && (
        <Switch
          checked={capabilities.webSearch === true}
          onChange={value => setFlag('webSearch', value)}
          label={t('userApps.edit.extras.webSearch')}
          help={t('userApps.edit.extras.webSearchHelp')}
        />
      )}
      {showSkills && (
        <Switch
          checked={capabilities.skills === true}
          onChange={value => setFlag('skills', value)}
          label={t('userApps.edit.extras.skills')}
        />
      )}

      {systems.length > 0 && (
        <fieldset className="space-y-3">
          <legend className={LABEL_CLASS}>{t('userApps.edit.extras.integrations')}</legend>
          <p className={HELP_CLASS}>{t('userApps.edit.extras.approvalHelp')}</p>
          {systems.map(system => {
            const binding = bindingOf(system.id);
            const label = system.label || system.id;
            return (
              <div key={system.id} data-testid={`user-app-system-${system.id}`}>
                <Switch
                  checked={Boolean(binding)}
                  onChange={checked => toggleSystem(system, checked)}
                  label={label}
                />
                {binding && (
                  <fieldset className="ml-6 mt-2 space-y-1.5">
                    <legend className="sr-only">{label}</legend>
                    {(Array.isArray(system.actions) ? system.actions : []).map(action => {
                      const name = typeof action === 'string' ? action : action?.name;
                      if (!name) return null;
                      return (
                        <Switch
                          key={name}
                          checked={binding.actions.includes(name)}
                          onChange={checked => toggleAction(system, name, checked)}
                          label={name}
                          help={typeof action === 'object' ? action.description : undefined}
                        />
                      );
                    })}
                  </fieldset>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      {nothing && (
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('userApps.create.limits')}</p>
      )}
    </div>
  );
}

export default UserAppExtrasSection;
