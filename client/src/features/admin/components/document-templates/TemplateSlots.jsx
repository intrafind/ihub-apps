// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SLOT_ID_PATTERN } from '../../utils/documentTemplates';
import {
  CALLOUT_CLASS,
  DANGER_BUTTON_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';

const LANGUAGES = ['en', 'de'];

/** The text placeholders of the template's layouts, by name: what a slot can point at. */
function placeholderNames(info) {
  const names = new Set();
  for (const layout of info?.layouts || []) {
    for (const element of layout.elements || []) {
      if (['body', 'obj', 'tx'].includes(element.type) && element.name) names.add(element.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function SlotCard({ id, slot, found, names, error, onChange, onRemove }) {
  const { t } = useTranslation();
  const baseId = useId();
  const set = patch => onChange({ ...slot, ...patch });
  return (
    <fieldset className="rounded-md border border-gray-200 dark:border-gray-700 p-3 space-y-3">
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <code>{id}</code>
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${baseId}-placeholder`} className={LABEL_CLASS}>
            {t('admin.documentTemplates.pptx.slots.placeholder', 'Placeholder in the layouts')}
          </label>
          <input
            id={`${baseId}-placeholder`}
            className={INPUT_CLASS}
            list={`${baseId}-names`}
            value={slot.placeholder || ''}
            onChange={event => set({ placeholder: event.target.value })}
          />
          <datalist id={`${baseId}-names`}>
            {names.map(name => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <p className={HELP_CLASS}>
            {t(
              'admin.documentTemplates.pptx.slots.placeholderHelp',
              "The placeholder's name in PowerPoint (View → Selection Pane), without regard to case."
            )}
          </p>
        </div>
        <div>
          <label htmlFor={`${baseId}-missing`} className={LABEL_CLASS}>
            {t('admin.documentTemplates.pptx.slots.ifMissing', 'In a layout without it')}
          </label>
          <select
            id={`${baseId}-missing`}
            className={INPUT_CLASS}
            value={slot.ifMissing || 'drop'}
            onChange={event => set({ ifMissing: event.target.value })}
          >
            <option value="drop">
              {t('admin.documentTemplates.pptx.slots.drop', 'Leave the text out')}
            </option>
            <option value="text">
              {t('admin.documentTemplates.pptx.slots.text', 'First paragraph of the slide text')}
            </option>
          </select>
        </div>
      </div>
      {LANGUAGES.map(language => (
        <div key={language}>
          <label htmlFor={`${baseId}-${language}`} className={LABEL_CLASS}>
            {t(
              'admin.documentTemplates.pptx.slots.description',
              'What to put in it ({{language}})',
              {
                language
              }
            )}
          </label>
          <input
            id={`${baseId}-${language}`}
            className={INPUT_CLASS}
            maxLength={200}
            value={slot.description?.[language] || ''}
            onChange={event =>
              set({ description: { ...slot.description, [language]: event.target.value } })
            }
          />
        </div>
      ))}
      <p className={HELP_CLASS}>
        {t(
          'admin.documentTemplates.pptx.slots.descriptionHelp',
          'The model reads this to know what belongs in the slot.'
        )}
      </p>
      {error && (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
      {found === false && (
        <p className={CALLOUT_CLASS.warning}>
          {t(
            'admin.documentTemplates.pptx.slots.notFound',
            'No layout has a placeholder with this name yet. Save, then upload the template or check the name.'
          )}
        </p>
      )}
      <button type="button" className={DANGER_BUTTON_CLASS} onClick={onRemove}>
        {t('admin.documentTemplates.pptx.slots.remove', 'Remove slot')}
      </button>
    </fieldset>
  );
}

/**
 * The text slots of a template's PowerPoint layouts: placeholders besides the
 * title and the content that slides can fill (a label above the title, an
 * introduction under it, the presenter). The model is told which slots exist,
 * where they sit and how much text fits.
 *
 * @param {Object} props
 * @param {Object<string, Object>} [props.slots] - `pptx.slots` of the draft.
 * @param {Object} [props.info] - What the uploaded PowerPoint template holds.
 * @param {Object<string, string>} [props.errors] - Problems by field (`slot:<id>`).
 * @param {(slots: Object<string, Object>) => void} props.onChange
 */
export default function TemplateSlots({ slots = {}, info, errors = {}, onChange }) {
  const { t } = useTranslation();
  const [newId, setNewId] = useState('');
  const newIdFieldId = useId();
  const names = placeholderNames(info);
  const found = Object.fromEntries(
    (info?.slots || []).map(slot => [slot.id, slot.layouts.length > 0])
  );
  const byConvention = (info?.slots || []).filter(
    slot => slot.source === 'convention' && slot.layouts.length > 0
  );
  const validId = SLOT_ID_PATTERN.test(newId) && !slots[newId];

  const add = () => {
    if (!validId) return;
    onChange({ ...slots, [newId]: { placeholder: '' } });
    setNewId('');
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('admin.documentTemplates.pptx.slots.title', 'Text slots')}
      </h3>
      <p className={HELP_CLASS}>
        {t(
          'admin.documentTemplates.pptx.slots.help',
          'Text placeholders of your layouts that slides can fill besides title and content, for example a label above the title. The model is told which slots exist, where they sit and how much text fits. A placeholder named "Kicker" or "Lead" is a slot without any setup here.'
        )}
      </p>
      {byConvention.length > 0 && (
        <ul className="mt-2 text-sm text-gray-700 dark:text-gray-300">
          {byConvention.map(slot => (
            <li key={slot.id}>
              <code>{slot.id}</code>{' '}
              {t('admin.documentTemplates.pptx.slots.foundIn', 'found in: {{layouts}}', {
                layouts: slot.layouts.map(layout => layout.name).join(', ')
              })}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 space-y-3">
        {Object.entries(slots).map(([id, slot]) => (
          <SlotCard
            key={id}
            id={id}
            slot={slot}
            found={info?.layouts ? found[id] : undefined}
            names={names}
            error={errors[`slot:${id}`]}
            onChange={next => onChange({ ...slots, [id]: next })}
            onRemove={() => {
              const { [id]: removed, ...rest } = slots;
              void removed;
              onChange(rest);
            }}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={newIdFieldId} className={LABEL_CLASS}>
            {t('admin.documentTemplates.pptx.slots.newId', 'New slot id')}
          </label>
          <input
            id={newIdFieldId}
            className={INPUT_CLASS}
            value={newId}
            placeholder="presenter"
            onChange={event => setNewId(event.target.value.trim())}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
        </div>
        <button type="button" className={SECONDARY_BUTTON_CLASS} disabled={!validId} onClick={add}>
          {t('admin.documentTemplates.pptx.slots.add', 'Add slot')}
        </button>
      </div>
      <p className={HELP_CLASS}>
        {t(
          'admin.documentTemplates.pptx.slots.newIdHelp',
          'Letters and digits, starting with a letter, such as "presenter" or "chapter".'
        )}
      </p>
    </div>
  );
}
