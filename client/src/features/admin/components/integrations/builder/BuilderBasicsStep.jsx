// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../../../shared/components/DynamicLanguageEditor';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS, MONO_INPUT_CLASS } from '../../formStyles';
import { slugify } from './builderModel';

/**
 * Step 1 of the integration builder: name, description, icon and the
 * installation id (proposed from the name while the integration is new,
 * fixed afterwards: tool ids and app bindings use it).
 *
 * @param {Object} props
 * @param {Object} props.draft
 * @param {(patch: Object) => void} props.onChange
 * @param {boolean} props.isNew
 * @param {Object<string, {key: string, defaultValue: string}>} props.errors
 * @returns {JSX.Element}
 */
function BuilderBasicsStep({ draft, onChange, isNew, errors }) {
  const { t, i18n } = useTranslation();
  const idId = useId();
  const iconId = useId();

  const onName = name => {
    const patch = { name };
    // Propose the id from the name until the admin types one of their own.
    const previous = slugify(draft.name?.en || draft.name?.[i18n.language] || '');
    if (isNew && (!draft.instanceId || draft.instanceId === previous)) {
      patch.instanceId = slugify(name?.en || name?.[i18n.language] || '');
    }
    onChange(patch);
  };

  return (
    <div className="space-y-5">
      <DynamicLanguageEditor
        label={t('admin.integrationBuilder.basics.name', 'Name')}
        value={draft.name || {}}
        onChange={onName}
        required
        name="name"
        error={errors.name ? t(errors.name.key, errors.name.defaultValue) : null}
        placeholder={{ en: 'Orders (ERP)', de: 'Bestellungen (ERP)' }}
      />
      <DynamicLanguageEditor
        label={t('admin.integrationBuilder.basics.description', 'Description')}
        value={draft.description || {}}
        onChange={description => onChange({ description })}
        type="textarea"
        placeholder={{
          en: 'What the integration connects to, shown to admins and users',
          de: 'Womit die Integration verbindet; für Admins und Nutzer sichtbar'
        }}
      />
      <div>
        <label htmlFor={idId} className={LABEL_CLASS}>
          {t('admin.integrationBuilder.basics.instanceId', 'ID')}
          <span className="text-red-600 dark:text-red-400 ml-0.5" aria-hidden="true">
            *
          </span>
        </label>
        <input
          id={idId}
          type="text"
          value={draft.instanceId}
          disabled={!isNew}
          required
          onChange={e => onChange({ instanceId: e.target.value.toLowerCase() })}
          className={MONO_INPUT_CLASS}
          aria-invalid={Boolean(errors.instanceId)}
          aria-describedby={`${idId}-help`}
        />
        <p id={`${idId}-help`} className={HELP_CLASS}>
          {errors.instanceId
            ? t(errors.instanceId.key, errors.instanceId.defaultValue)
            : t(
                'admin.integrationBuilder.basics.instanceIdHelp',
                'Tool ids are <id>__<action>; apps bind the integration by this id. It cannot change later.'
              )}
        </p>
      </div>
      <div>
        <label htmlFor={iconId} className={LABEL_CLASS}>
          {t('admin.integrationBuilder.basics.icon', 'Icon URL (optional)')}
        </label>
        <input
          id={iconId}
          type="url"
          value={draft.icon || ''}
          onChange={e => onChange({ icon: e.target.value })}
          className={INPUT_CLASS}
          placeholder="https://example.com/icon.svg"
          aria-invalid={Boolean(errors.icon)}
          aria-describedby={`${iconId}-help`}
        />
        <p id={`${iconId}-help`} className={HELP_CLASS}>
          {errors.icon
            ? t(errors.icon.key, errors.icon.defaultValue)
            : t(
                'admin.integrationBuilder.basics.iconHelp',
                'An https URL; registries and the Marketplace show it when the integration is published.'
              )}
        </p>
      </div>
    </div>
  );
}

export default BuilderBasicsStep;
