// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import IconPicker from '../../../../shared/components/IconPicker';
import { LABEL_CLASS } from '../formStyles';
import { AppTile } from './AppPickCard';
import ColorSwatchPicker from './ColorSwatchPicker';
import { isLinkDraft } from './createErrors';
import { fieldDomId } from './createKeys';
import { DISCLOSURE_BUTTON_CLASS } from './createStyles';
import FormField from './FormField';
import LinkFields from './LinkFields';

/** The three tips behind "Tips for good instructions". */
const INSTRUCTION_TIP_KEYS = Object.freeze([
  'admin.apps.create.essentials.tips.role',
  'admin.apps.create.essentials.tips.form',
  'admin.apps.create.essentials.tips.limits'
]);

/**
 * The fields of the Essentials screen: name, short description, and the
 * instructions of a chat app or the website address of a link app. Below
 * them, in reading order, the icon and the colour with a tile that shows the
 * app as the app list will.
 *
 * The component holds no value. It shows `draft` in `language` and reports
 * every change; which message a field shows is the caller's decision.
 *
 * @param {object} props
 * @param {object} props.draft - The app as the author sees it.
 * @param {string} props.language - The language of the texts being edited.
 * @param {boolean} [props.instructionsRequired=true]
 * @param {string} [props.instructionsHelpKey] - The key of the help under the instructions;
 *   the admin text ("users do not see it") by default.
 * @param {Object<string, string|true>} [props.errors] - By field: the message,
 *   or `true` for a field that is marked and explained by `describedBy`.
 * @param {Object<string, string[]>} [props.notes] - By field: hints that do not block.
 * @param {string} [props.describedBy] - The id of the element that explains marked fields.
 * @param {(field: 'name'|'description'|'system', value: string) => void} props.onTextChange
 * @param {(field: string) => void} props.onBlur
 * @param {(change: { url?: string, mode?: 'redirect'|'iframe' }) => void} props.onLinkChange
 * @param {(field: 'icon'|'color', value: string) => void} props.onMetaChange
 * @param {{ current: HTMLElement|null }} [props.nameRef] - The name input.
 * @returns {JSX.Element}
 */
function EssentialsForm({
  draft,
  language,
  instructionsRequired = true,
  instructionsHelpKey = 'admin.apps.create.essentials.instructionsHelp',
  errors = {},
  notes = {},
  describedBy,
  onTextChange,
  onBlur,
  onLinkChange,
  onMetaChange,
  nameRef
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const [tipsOpen, setTipsOpen] = useState(false);
  const tipsId = `${baseId}-tips`;
  const iconLabelId = `${baseId}-icon-label`;
  const linkApp = isLinkDraft(draft);
  const text = field => draft?.[field]?.[language] ?? '';

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <FormField
          field="name"
          label={t('admin.apps.create.essentials.name')}
          required
          help={t('admin.apps.create.essentials.nameHelp')}
          error={errors.name}
          notes={notes.name}
          describedBy={describedBy}
        >
          {control => (
            <input
              {...control}
              ref={nameRef}
              type="text"
              value={text('name')}
              placeholder={t('admin.apps.create.essentials.namePlaceholder')}
              autoComplete="off"
              onChange={event => onTextChange('name', event.target.value)}
              onBlur={() => onBlur('name')}
            />
          )}
        </FormField>

        <FormField
          field="description"
          label={t('admin.apps.create.essentials.description')}
          required
          help={t('admin.apps.create.essentials.descriptionHelp')}
          error={errors.description}
          notes={notes.description}
          describedBy={describedBy}
        >
          {control => (
            <input
              {...control}
              type="text"
              value={text('description')}
              placeholder={t('admin.apps.create.essentials.descriptionPlaceholder')}
              autoComplete="off"
              onChange={event => onTextChange('description', event.target.value)}
              onBlur={() => onBlur('description')}
            />
          )}
        </FormField>

        {linkApp ? (
          <LinkFields
            draft={draft}
            urlError={errors.url}
            describedBy={describedBy}
            onChange={onLinkChange}
            onBlur={onBlur}
          />
        ) : (
          <FormField
            field="system"
            label={t('admin.apps.create.essentials.instructions')}
            required={instructionsRequired}
            help={t(instructionsHelpKey)}
            error={errors.system}
            notes={notes.system}
            describedBy={describedBy}
            aside={
              <button
                type="button"
                className={DISCLOSURE_BUTTON_CLASS}
                aria-expanded={tipsOpen}
                aria-controls={tipsId}
                onClick={() => setTipsOpen(open => !open)}
              >
                {t('admin.apps.create.essentials.tips.toggle')}
                <Icon
                  name={tipsOpen ? 'chevron-down' : 'chevron-right'}
                  size="sm"
                  aria-hidden="true"
                />
              </button>
            }
          >
            {control => (
              <>
                <div id={tipsId}>
                  {tipsOpen && (
                    <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300">
                      {INSTRUCTION_TIP_KEYS.map(key => (
                        <li key={key}>{t(key)}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <textarea
                  {...control}
                  rows={6}
                  value={text('system')}
                  placeholder={t('admin.apps.create.essentials.instructionsPlaceholder')}
                  onChange={event => onTextChange('system', event.target.value)}
                  onBlur={() => onBlur('system')}
                />
              </>
            )}
          </FormField>
        )}
      </div>

      {/* After the three texts, in reading order: defaults exist, so nobody has to stop here. */}
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)_auto]">
        <div className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 sm:col-span-2 lg:col-span-1">
          <AppTile icon={draft?.icon} color={draft?.color} size="lg" />
          <div className="min-w-0" aria-hidden="true">
            <p className="break-words text-sm font-semibold text-gray-900 dark:text-gray-100">
              {text('name') || t('admin.apps.create.essentials.namePlaceholder')}
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400 line-clamp-2">
              {text('description') || t('admin.apps.create.essentials.descriptionPlaceholder')}
            </p>
          </div>
        </div>
        <div>
          <span id={iconLabelId} className={LABEL_CLASS}>
            {t('admin.apps.create.essentials.icon')}
          </span>
          <IconPicker
            id={fieldDomId('icon')}
            labelledBy={iconLabelId}
            value={draft?.icon}
            onChange={icon => onMetaChange('icon', icon)}
          />
        </div>
        <ColorSwatchPicker
          label={t('admin.apps.create.essentials.color')}
          value={draft?.color}
          onChange={color => onMetaChange('color', color)}
        />
      </div>
    </div>
  );
}

export default EssentialsForm;
