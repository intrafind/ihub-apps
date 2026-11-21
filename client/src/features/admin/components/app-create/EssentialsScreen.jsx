// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UI_CREATES_PUBLISHED } from '../../../../../../shared/appDefaults.js';
import { uniqueAppId } from '../../../../../../shared/appId.js';
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import AppDetailsDisclosure from './AppDetailsDisclosure';
import CreateErrorSummary from './CreateErrorSummary';
import { derivedAppId, fieldsLosingLanguages } from './createFlow';
import { DETAIL_FIELDS, FIELD_LABEL_KEYS, FIELD_ORDER, fieldDomId } from './createKeys';
import EssentialsForm from './EssentialsForm';
import { usePointerSettled } from './usePointerSettled';

/** The name of a language in the language of the UI ("German", "Deutsch"). */
function languageName(language, uiLanguage) {
  try {
    return new Intl.DisplayNames([uiLanguage], { type: 'language' }).of(language) || language;
  } catch {
    return language;
  }
}

/**
 * Screen 2 of "New app": the notice of the start, the summary of what needs
 * attention, the fields, "More details", the one sentence about who sees the
 * new app, and the buttons.
 *
 * The screen connects the fields with the page's state: every change goes to
 * the draft, the app ID follows the name until the author edits it, and a
 * derived ID is kept free. It owns only what is about looking at it: whether
 * "More details" is open, and where the focus goes after a submit that could
 * not go ahead.
 *
 * @param {object} props
 * @param {object} props.draft - The page's state with its actions (`useAppDraft`).
 * @param {object} props.form - Validation and the request (`useCreateSubmit`).
 * @param {React.ReactNode} [props.notice] - What stands above the fields for this start.
 * @param {(id: string) => boolean} props.isTaken - Whether an app has this ID.
 * @param {(name: string) => boolean} props.nameExists - Whether an app has this name.
 * @param {boolean} [props.idsKnown=false] - The list of existing apps was loaded.
 * @param {Array<{ id: string, name: string|object }>} [props.categories]
 * @param {string} [props.platformLanguage] - The platform's default language.
 * @param {{ current: HTMLElement|null }} [props.nameRef]
 * @param {() => void} props.onCancel
 * @returns {JSX.Element}
 */
function EssentialsScreen({
  draft,
  form,
  notice,
  isTaken,
  nameExists,
  idsKnown = false,
  categories = [],
  platformLanguage,
  nameRef,
  onCancel
}) {
  const { t, i18n } = useTranslation();
  const summaryId = useId();
  const summaryRef = useRef(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const whenPointerSettled = usePointerSettled();
  const { state, editText, editMeta, editId, editLink, deriveId } = draft;
  const { focus, clearFocus, requestFocus, touch, leave } = form;

  // A field under "More details" can only take the focus once that part is open.
  if (focus && DETAIL_FIELDS.includes(focus.target) && !detailsOpen) setDetailsOpen(true);

  // After a submit that could not go ahead: to the summary, or to the field
  // the server refused.
  useEffect(() => {
    if (!focus) return;
    const element =
      focus.target === 'summary'
        ? summaryRef.current
        : document.getElementById(fieldDomId(focus.target));
    element?.focus();
    clearFocus();
  }, [focus, detailsOpen, clearFocus]);

  const name = state.draft?.name?.[state.language] ?? '';
  const appId = state.draft?.id ?? '';
  const { idTouched } = state;

  // An ID the page derived must stay free: when the list of apps arrives, and
  // when the author leaves the name field.
  const keepIdFree = useCallback(() => {
    if (idTouched || !appId || !isTaken(appId)) return;
    deriveId(derivedAppId(name, isTaken) || uniqueAppId(appId, isTaken));
  }, [idTouched, appId, name, isTaken, deriveId]);
  useEffect(keepIdFree, [keepIdFree]);

  const messageOf = error => (error.key ? t(error.key, error.values).trim() : null);
  const fieldMessages = Object.fromEntries(
    Object.entries(form.errors).map(([field, error]) => [field, messageOf(error) ?? true])
  );
  const entries = FIELD_ORDER.filter(field => form.errors[field]).map(field => ({
    field,
    label: t(FIELD_LABEL_KEYS[field]),
    message: messageOf(form.errors[field])
  }));
  const general = form.general ? t(form.general.key, form.general.values).trim() : null;

  // Hints that do not block, under the field they are about, so the field the
  // author is typing in never moves.
  const notes = {};
  if (form.hasLeft('name') && nameExists(name)) {
    notes.name = [t('admin.apps.create.essentials.nameExists', { name: name.trim() })];
  }
  // A copy: the other languages of a changed text go. Said once, at the first such field.
  const [losesLanguages] = fieldsLosingLanguages(state);
  if (losesLanguages) {
    notes[losesLanguages] = [
      ...(notes[losesLanguages] || []),
      t('admin.apps.create.copy.languagesNote')
    ];
  }
  const showSummary = form.submitted && (entries.length > 0 || Boolean(general));

  return (
    <div className="space-y-6">
      {notice}

      <form
        noValidate
        className="space-y-6"
        onSubmit={event => {
          event.preventDefault();
          form.submit();
        }}
      >
        {showSummary && (
          <CreateErrorSummary
            summaryRef={summaryRef}
            id={summaryId}
            entries={entries}
            general={general}
            onGoTo={requestFocus}
          />
        )}

        <p className="text-xs text-gray-600 dark:text-gray-400">
          {t('admin.apps.create.requiredHint')}
        </p>

        <EssentialsForm
          draft={state.draft}
          language={state.language}
          instructionsRequired={!form.instructionsOptional}
          errors={fieldMessages}
          notes={notes}
          describedBy={summaryId}
          nameRef={nameRef}
          onTextChange={(field, value) => {
            touch(field);
            editText(field, value, field === 'name' ? derivedAppId(value, isTaken) : undefined);
          }}
          onMetaChange={(field, value) => {
            touch(field);
            editMeta(field, value);
          }}
          onLinkChange={change => {
            touch(change.mode === undefined ? 'url' : 'mode');
            editLink(change);
          }}
          onBlur={field =>
            // What leaving a field shows must not move a button the author is pressing.
            whenPointerSettled(() => {
              leave(field);
              if (field === 'name') keepIdFree();
            })
          }
        />

        <AppDetailsDisclosure
          open={detailsOpen}
          onToggle={() => setDetailsOpen(open => !open)}
          appId={appId}
          onIdChange={value => {
            touch('id');
            editId(value);
          }}
          idError={fieldMessages.id ?? null}
          idAvailable={idTouched && idsKnown && !form.errors.id}
          describedBy={summaryId}
          category={state.draft?.category}
          categories={categories}
          onCategoryChange={category => {
            touch('category');
            editMeta('category', category);
          }}
          language={state.language}
        />

        <div className="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-4">
          {platformLanguage && state.language !== platformLanguage && (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('admin.apps.create.essentials.language', {
                language: languageName(state.language, i18n.language)
              })}
            </p>
          )}
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {UI_CREATES_PUBLISHED
              ? t('admin.apps.create.essentials.audienceLive')
              : t('admin.apps.create.essentials.audience')}
          </p>
          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
            <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onCancel}>
              {t('admin.apps.create.cancel')}
            </button>
            <button
              type="submit"
              className={`${PRIMARY_BUTTON_CLASS} aria-disabled:cursor-progress`}
              aria-disabled={form.submitting ? 'true' : undefined}
            >
              {form.submitting ? t('admin.apps.create.submitting') : t('admin.apps.create.submit')}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default EssentialsScreen;
