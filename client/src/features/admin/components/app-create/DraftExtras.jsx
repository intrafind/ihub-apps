// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../../shared/components/ConfirmDialog';
import Icon from '../../../../shared/components/Icon';
import { APP_GENERATOR_WARNINGS } from '../../../../../../shared/appGenerator.js';
import { variablesUsedInInstructions } from '../../../../../../shared/appPlaceholders.js';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { CALLOUT_CLASS, CHECKBOX_CLASS, INPUT_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import { DRAFT_LINK_BUTTON_CLASS, useDraftRequest } from './DescribeStart';
import { descriptionProblem } from './generateErrors';

const LEGEND_CLASS = 'text-sm font-semibold';

/** True for a warning that says the author may miss something in the draft. */
const isLeftOut = warning =>
  ['dropped', 'shortened'].includes(APP_GENERATOR_WARNINGS[warning?.code]);

/** The label of an input field in the content language, else in any language, else its name. */
const labelOf = (field, language) =>
  getLocalizedContent(field?.label, language, language) || field?.name;

/** A draft as text, to tell whether the author changed it. */
const snapshot = draft => JSON.stringify(draft ?? null);

/** One checkbox row of the notice. */
function Option({ checked, onChange, children, ...rest }) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className={`${CHECKBOX_CLASS} mt-0.5`}
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        {...rest}
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * The draft notice at the top of the Essentials screen, shown for a draft the
 * AI prepared. It holds the whole loop: the author's description in an
 * editable box with "Prepare a new draft", and what the draft contains beyond
 * its texts.
 *
 * - Input fields the AI proposed are listed and ticked. The checkbox is locked
 *   while the instructions use one of the fields.
 * - Web search and connected systems are suggestions and start unticked.
 *
 * A request can run for a long time, and the fields below stay editable
 * meanwhile. An answer that arrives after the author changed the draft is
 * held back until the author chose between it and those changes. A create
 * request that starts meanwhile cancels the draft request: the author decided
 * for the draft on the screen.
 *
 * The component changes no draft. It reports what is ticked as `extras`, in
 * the shape `draftFromGenerated(result, extras)` takes, and hands a new
 * answer to `onDraft`. It makes no request of its own: `generate` is the call
 * of the API module.
 *
 * @param {object} props
 * @param {object} [props.source] - What the create page offers. `source.suggestions` says
 *   whether web search and connected systems may be offered; without a source both may.
 * @param {{ app: object, suggestions?: { websearch?: boolean, integrations?: Array<{ id: string, label?: string, actions?: string[] }> }, warnings?: Array<{ code: string }>, brief?: string }} props.result
 *   The body of `POST /api/admin/apps/_generate` the current draft came from.
 * @param {object} [props.draft] - The draft as the author edited it. Its instructions decide
 *   whether the input fields can be removed; without it the instructions of `result.app` do.
 * @param {string} props.description - The author's description.
 * @param {(text: string) => void} props.onDescriptionChange
 * @param {{ inputFields?: boolean, webSearch?: boolean, integrationIds?: string[] }} [props.extras]
 *   What is ticked. Default: input fields ticked, no suggestion ticked.
 * @param {(extras: { inputFields: boolean, webSearch: boolean, integrationIds: string[] }) => void} props.onExtrasChange
 * @param {(result: object, description: string) => void} props.onDraft - A new draft arrived; it
 *   replaces the current one.
 * @param {(request: { description: string, language?: string, signal: AbortSignal }) => Promise<object>} props.generate
 * @param {string} [props.language] - The content language of the draft; the UI language when absent.
 * @param {boolean|string[]|Set<string>} [props.edited=false] - Whether the author changed a
 *   field of the draft. If so, "Prepare a new draft" asks first.
 * @param {boolean} [props.creating=false] - The create request runs; a draft request is cancelled.
 * @param {() => void} [props.onStartOver] - Shows "Start over" when given.
 * @returns {JSX.Element}
 */
function DraftExtras({
  source,
  result,
  draft,
  description = '',
  onDescriptionChange,
  extras,
  onExtrasChange,
  onDraft,
  generate,
  language,
  edited = false,
  creating = false,
  onStartOver
}) {
  const { t, i18n } = useTranslation();
  const baseId = useId();
  const contentLanguage = language ?? i18n?.language;
  const [confirming, setConfirming] = useState(false);
  // An answer that waits for the author's choice: `{ next, sent }`, or null.
  const [held, setHeld] = useState(null);
  const [arrived, setArrived] = useState(false);
  const regenerateRef = useRef(null);
  // The draft now, and the draft the running request was started from.
  const draftRef = useRef(draft);
  const sentFromRef = useRef(null);
  useEffect(() => {
    draftRef.current = draft;
  });

  const { pending, error, start, cancel, clearInputError } = useDraftRequest({
    generate,
    language: contentLanguage,
    onDraft: (next, sent) => {
      setArrived(true);
      // What the author changed while waiting is not replaced without asking.
      if (snapshot(draftRef.current) !== sentFromRef.current) setHeld({ next, sent });
      else onDraft(next, sent);
    }
  });

  useEffect(() => {
    if (creating) cancel();
  }, [creating, cancel]);

  const introId = `${baseId}-intro`;
  const fieldId = `${baseId}-description`;
  const errorId = `${baseId}-error`;
  const lockedId = `${baseId}-locked`;
  const suggestionsHelpId = `${baseId}-suggestions-help`;

  const ticked = {
    inputFields: extras?.inputFields !== false,
    webSearch: extras?.webSearch === true,
    integrationIds: Array.isArray(extras?.integrationIds) ? extras.integrationIds : []
  };

  const fields = Array.isArray(result?.app?.variables) ? result.app.variables : [];
  const fieldsLocked =
    ticked.inputFields &&
    variablesUsedInInstructions({ system: (draft ?? result?.app)?.system, variables: fields })
      .length > 0;

  const webSearchOffered =
    source?.suggestions?.webSearch !== false && result?.suggestions?.websearch === true;
  const systems =
    source?.suggestions?.integrations !== false && Array.isArray(result?.suggestions?.integrations)
      ? result.suggestions.integrations.filter(system => typeof system?.id === 'string')
      : [];
  const leftOut = Array.isArray(result?.warnings) && result.warnings.some(isLeftOut);

  const hasEdits =
    edited instanceof Set ? edited.size > 0 : Array.isArray(edited) ? edited.length > 0 : !!edited;
  const fieldNames = fields.map(field => labelOf(field, contentLanguage)).join(', ');

  const toggleSystem = (id, checked) => {
    const wanted = new Set(ticked.integrationIds);
    if (checked) wanted.add(id);
    else wanted.delete(id);
    // In the order of the suggestions, so the same ticks always give the same app.
    onExtrasChange({
      ...ticked,
      integrationIds: systems.map(system => system.id).filter(systemId => wanted.has(systemId))
    });
  };

  const begin = () => {
    setArrived(false);
    sentFromRef.current = snapshot(draftRef.current);
    void start(description);
  };

  const handleRegenerate = () => {
    if (pending || creating) return;
    // A description that cannot be sent is reported first; nothing would be replaced.
    if (hasEdits && !descriptionProblem(description)) setConfirming(true);
    else begin();
  };

  const handleCancel = () => {
    cancel();
    // The Cancel button is gone after this; keep the keyboard where the author was.
    regenerateRef.current?.focus();
  };

  return (
    <section aria-labelledby={introId} className={`${CALLOUT_CLASS.info} space-y-3`}>
      <p className="flex items-start gap-2">
        <Icon name="sparkles" size="sm" className="mt-0.5 shrink-0" aria-hidden="true" />
        <span id={introId}>{t('admin.apps.create.draft.intro')}</span>
      </p>
      {result?.brief === 'customised' && <p>{t('admin.apps.create.draft.briefCustomised')}</p>}
      {leftOut && <p>{t('admin.apps.create.draft.leftOut')}</p>}

      <div>
        <label htmlFor={fieldId} className="mb-1 block text-sm font-medium">
          {t('admin.apps.create.start.label')}
        </label>
        <textarea
          id={fieldId}
          rows={3}
          className={INPUT_CLASS}
          value={description}
          readOnly={pending}
          aria-invalid={error?.input ? 'true' : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={event => {
            clearInputError();
            onDescriptionChange(event.target.value);
          }}
        />
      </div>

      {error && (
        <p id={errorId} role="alert" className={CALLOUT_CLASS.danger}>
          {t(error.key, error.values).trim()}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          ref={regenerateRef}
          type="button"
          className={`${SECONDARY_BUTTON_CLASS} aria-disabled:cursor-progress`}
          aria-disabled={pending ? 'true' : undefined}
          onClick={handleRegenerate}
        >
          {pending && (
            <Icon
              name="spinner"
              size="sm"
              className="shrink-0 motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          <span>
            {pending
              ? t('admin.apps.create.start.generating')
              : t('admin.apps.create.draft.regenerate')}
          </span>
        </button>
        {pending && (
          <button type="button" className={DRAFT_LINK_BUTTON_CLASS} onClick={handleCancel}>
            {t('admin.apps.create.cancel')}
          </button>
        )}
        {onStartOver && (
          <button
            type="button"
            className={`${DRAFT_LINK_BUTTON_CLASS} sm:ml-auto`}
            onClick={onStartOver}
          >
            {t('admin.apps.create.startOver')}
          </button>
        )}
      </div>

      {fields.length > 0 && (
        <fieldset className="space-y-1">
          <legend className={LEGEND_CLASS}>{t('admin.apps.create.draft.also')}</legend>
          <Option
            checked={ticked.inputFields}
            disabled={fieldsLocked}
            aria-describedby={fieldsLocked ? lockedId : undefined}
            onChange={checked => onExtrasChange({ ...ticked, inputFields: checked })}
          >
            {t('admin.apps.create.draft.inputFields', { names: fieldNames })}
          </Option>
          {fieldsLocked && <p id={lockedId}>{t('admin.apps.create.draft.fieldsLocked')}</p>}
        </fieldset>
      )}

      {(webSearchOffered || systems.length > 0) && (
        <fieldset className="space-y-1" aria-describedby={suggestionsHelpId}>
          <legend className={LEGEND_CLASS}>{t('admin.apps.create.draft.suggestions')}</legend>
          <p id={suggestionsHelpId}>{t('admin.apps.create.draft.suggestionsHelp')}</p>
          {webSearchOffered && (
            <Option
              checked={ticked.webSearch}
              onChange={checked => onExtrasChange({ ...ticked, webSearch: checked })}
            >
              {t('admin.apps.create.draft.webSearch')}
            </Option>
          )}
          {systems.map(system => {
            const name = system.label || system.id;
            const actions = Array.isArray(system.actions) ? system.actions.join(', ') : '';
            return (
              <Option
                key={system.id}
                checked={ticked.integrationIds.includes(system.id)}
                onChange={checked => toggleSystem(system.id, checked)}
              >
                {actions
                  ? t('admin.apps.create.draft.system', { name, actions })
                  : t('admin.apps.create.draft.systemAll', { name })}
              </Option>
            );
          })}
        </fieldset>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {pending && t('admin.apps.create.start.generating')}
        {!pending && arrived && t('admin.apps.create.draft.intro')}
      </p>

      <ConfirmDialog
        isOpen={confirming}
        title={t('admin.apps.create.draft.regenerate')}
        message={t('admin.apps.create.draft.regenerateWarning')}
        confirmLabel={t('admin.apps.create.draft.regenerate')}
        onConfirm={() => {
          setConfirming(false);
          begin();
        }}
        onDeny={() => setConfirming(false)}
      />
      <ConfirmDialog
        isOpen={held !== null}
        title={t('admin.apps.create.draft.arrived.title')}
        message={t('admin.apps.create.draft.arrived.body')}
        confirmLabel={t('admin.apps.create.draft.arrived.use')}
        denyLabel={t('admin.apps.create.draft.arrived.keep')}
        onConfirm={() => {
          setHeld(null);
          onDraft(held.next, held.sent);
        }}
        onDeny={() => setHeld(null)}
      />
    </section>
  );
}

export default DraftExtras;
