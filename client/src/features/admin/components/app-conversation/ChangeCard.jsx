// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { CHECKBOX_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import {
  changeKeysOf,
  changeSections,
  changedLanguages,
  linesOf,
  offeredSuggestions,
  unsavedOutsideChange,
  warningKey
} from './conversationState';
import { diffLines, foldUnchanged } from './lineDiff';

const LINE_CLASS = 'block whitespace-pre-wrap break-words px-2 py-0.5';
const DEL_CLASS = `${LINE_CLASS} bg-red-50 text-red-900 line-through decoration-red-700/60 dark:bg-red-900/30 dark:text-red-100`;
const INS_CLASS = `${LINE_CLASS} bg-green-50 text-green-900 no-underline dark:bg-green-900/30 dark:text-green-100`;
const SAME_CLASS = `${LINE_CLASS} text-gray-700 dark:text-gray-300`;
const LINK_BUTTON_CLASS =
  'rounded-sm text-sm font-medium text-admin-accent underline hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:text-admin-accent-fg-dark';

/**
 * Unchanged lines folded into one row; a button shows them.
 *
 * @param {object} props
 * @param {Array<{at: number, text: string}>} props.lines
 * @returns {JSX.Element}
 */
function FoldedLines({ lines }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <>
        {lines.map(line => (
          <span key={line.at} className={SAME_CLASS}>
            {line.text || ' '}
          </span>
        ))}
        <span className="block px-2 py-1">
          <button type="button" className={LINK_BUTTON_CLASS} onClick={() => setOpen(false)}>
            {t('admin.apps.conversation.change.hideUnchanged')}
          </button>
        </span>
      </>
    );
  }
  return (
    <span className="block px-2 py-1">
      <button type="button" className={LINK_BUTTON_CLASS} onClick={() => setOpen(true)}>
        {t('admin.apps.conversation.change.showUnchanged', { count: lines.length })}
      </button>
    </span>
  );
}

/**
 * The line diff of one value: removed lines in `<del>`, added lines in
 * `<ins>`, each with a visually hidden "removed:"/"added:" so that the change
 * never depends on colour or a strike-through alone. Removed and added lines
 * are shown in full; long unchanged runs fold.
 *
 * @param {object} props
 * @param {string[]} props.before
 * @param {string[]} props.after
 * @returns {JSX.Element}
 */
export function LineDiff({ before, after }) {
  const { t } = useTranslation();
  const rows = foldUnchanged(diffLines(before, after));
  return (
    <div
      data-testid="line-diff"
      className="overflow-hidden rounded-md border border-gray-200 bg-white font-mono text-xs leading-5 dark:border-gray-700 dark:bg-gray-900"
    >
      {rows.length === 0 && (
        <span className={SAME_CLASS}>{t('admin.apps.conversation.change.empty')}</span>
      )}
      {rows.map(row => {
        if (row.type === 'fold') return <FoldedLines key={row.at} lines={row.lines} />;
        if (row.type === 'del') {
          return (
            <del key={row.at} className={DEL_CLASS}>
              <span className="sr-only">{t('admin.apps.conversation.change.removed')} </span>
              <span aria-hidden="true" className="select-none">
                −{' '}
              </span>
              {row.text}
            </del>
          );
        }
        if (row.type === 'ins') {
          return (
            <ins key={row.at} className={INS_CLASS}>
              <span className="sr-only">{t('admin.apps.conversation.change.added')} </span>
              <span aria-hidden="true" className="select-none">
                +{' '}
              </span>
              {row.text}
            </ins>
          );
        }
        return (
          <span key={row.at} className={SAME_CLASS}>
            <span aria-hidden="true" className="select-none">
              {'  '}
            </span>
            {row.text}
          </span>
        );
      })}
    </div>
  );
}

/**
 * One changed part of the app: its plain heading, then the diff of each
 * language the change touches.
 */
function ChangeSection({ section, before, patch, language }) {
  const { t } = useTranslation();
  const parts = [];
  for (const key of section.keys) {
    const languages = changedLanguages(key, before[key], patch[key], language);
    for (const lang of languages) {
      const shown = lang || language;
      parts.push({
        id: `${key}-${lang}`,
        lang: languages.length > 1 && lang ? lang : null,
        before: linesOf(key, before[key], shown, t),
        after: linesOf(key, patch[key], shown, t)
      });
    }
  }
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t(section.labelKey)}
      </h4>
      {parts.map(part => (
        <div key={part.id} lang={part.lang || undefined}>
          {part.lang && (
            <p className="mb-1 text-xs font-medium uppercase text-gray-600 dark:text-gray-400">
              {t('admin.apps.conversation.change.languageLabel', { language: part.lang })}
            </p>
          )}
          <LineDiff before={part.before} after={part.after} />
        </div>
      ))}
    </section>
  );
}

/**
 * The card of a proposed change (plan 3.1): a heading per changed part with
 * its line diff, the warnings as plain sentences, the suggestions to tick,
 * the stakes line that names who gets the change, and Apply / Dismiss.
 *
 * Apply is offered only on the newest entry, and only while the form still
 * holds the content the change was made for (`stale` says it does not).
 * After Apply the card shows the "Applied" line, which takes the focus; Undo
 * is on it while this is the newest applied change and every part it set
 * still holds the applied value.
 *
 * The card holds no input except the suggestion ticks: it is not a third
 * editor. It knows no request; every action is a callback.
 *
 * @param {object} props
 * @param {import('./useConversation').ConversationEntry} props.entry
 * @param {'admin'|'personal'} props.target
 * @param {object|null} props.form - The app as the editor holds it.
 * @param {string} props.language - The content language.
 * @param {boolean} props.interactive - The newest entry, with no turn running: Apply and
 *   Dismiss are offered.
 * @param {boolean} props.stale - The form's content changed since the change was made.
 * @param {boolean} props.undoAvailable - Every part the change set still holds the applied value.
 * @param {Array<{key: string, values?: object}>} [props.stakes] - Who gets the change.
 * @param {boolean} [props.testOpen=false] - The test chat is beside the conversation.
 * @param {object|null} [props.saved=null] - The app as it was last loaded or saved. Apply
 *   and Undo save the whole form: when the form differs from it outside the keys this
 *   change writes, the card says those edits are saved too (`unsavedOutsideChange`).
 * @param {(ticked: { webSearch: boolean, integrationIds: string[] }) => void} props.onApply
 * @param {() => void} props.onDismiss
 * @param {() => void} props.onUndo
 * @param {{ current: HTMLElement|null }} [props.appliedRef] - The "Applied" line, for the focus.
 * @returns {JSX.Element}
 */
function ChangeCard({
  entry,
  target,
  form,
  language,
  interactive,
  stale,
  undoAvailable,
  stakes = [],
  testOpen = false,
  saved = null,
  onApply,
  onDismiss,
  onUndo,
  appliedRef
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const [ticked, setTicked] = useState({ webSearch: false, integrationIds: [] });
  const patch = entry.patch || {};
  const before = entry.baseSnapshot || {};
  const sections = changeSections(Object.keys(patch));
  const status = entry.status;
  const proposed = status === 'proposed' || status === 'applying';
  const offered = proposed
    ? offeredSuggestions(target, form, entry.suggestions)
    : { webSearch: false, integrations: [] };
  // Per card: the author's unsaved edits are what differs from the saved app outside the keys
  // this change (with the suggestions ticked now) writes.
  const savesOtherChanges = unsavedOutsideChange(
    form,
    saved,
    changeKeysOf(target, form, entry, ticked)
  );
  // One sentence per kind of warning: several dropped fields say it once.
  const warningKeys = [...new Set((entry.warnings || []).map(warningKey))];
  const staleId = `${baseId}-stale`;
  const undoBlockedId = `${baseId}-undo-blocked`;
  const alsoSavesId = `${baseId}-also-saves`;
  /** The ids that describe Apply: why it is off, and what else it saves. */
  const applyDescription =
    [stale ? staleId : null, savesOtherChanges ? alsoSavesId : null].filter(Boolean).join(' ') ||
    undefined;

  const toggleSystem = (id, checked) =>
    setTicked(held => ({
      ...held,
      integrationIds: checked
        ? [...held.integrationIds, id]
        : held.integrationIds.filter(other => other !== id)
    }));

  return (
    <article
      aria-labelledby={`${baseId}-heading`}
      data-testid="change-card"
      className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800 sm:p-4"
    >
      <h3 id={`${baseId}-heading`} className="sr-only">
        {t('admin.apps.conversation.change.heading')}
      </h3>
      {sections.map(section => (
        <ChangeSection
          key={section.id}
          section={section}
          before={before}
          patch={patch}
          language={language}
        />
      ))}

      {warningKeys.length > 0 && (
        <ul className="space-y-1 text-sm text-amber-900 dark:text-amber-200">
          {warningKeys.map(key => (
            <li key={key} className="flex gap-1.5">
              <Icon
                name="information-circle"
                size="sm"
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              {t(key)}
            </li>
          ))}
        </ul>
      )}

      {proposed && interactive && (offered.webSearch || offered.integrations.length > 0) && (
        <fieldset className="space-y-1 text-sm text-gray-800 dark:text-gray-200">
          <legend className="font-medium">{t('admin.apps.conversation.change.suggestions')}</legend>
          {offered.webSearch && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className={CHECKBOX_CLASS}
                checked={ticked.webSearch}
                onChange={event =>
                  setTicked(held => ({ ...held, webSearch: event.target.checked }))
                }
              />
              {t('admin.apps.conversation.change.webSearch')}
            </label>
          )}
          {offered.integrations.map(system => (
            <label key={system.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                className={CHECKBOX_CLASS}
                checked={ticked.integrationIds.includes(system.id)}
                onChange={event => toggleSystem(system.id, event.target.checked)}
              />
              {t('admin.apps.conversation.change.integration', { name: system.label })}
            </label>
          ))}
        </fieldset>
      )}

      {proposed && stakes.length > 0 && (
        <p data-testid="change-stakes" className="text-sm text-gray-700 dark:text-gray-300">
          {stakes.map(sentence => t(sentence.key, sentence.values)).join(' ')}
        </p>
      )}

      {proposed && entry.problem === 'conflict' && (
        <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-200">
          {t('admin.apps.conversation.change.conflict')}
        </p>
      )}
      {proposed && entry.problem === 'failed' && (
        <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-200">
          {t('admin.apps.conversation.change.failed', { detail: entry.problemText || '' })}
        </p>
      )}

      {proposed && interactive && (
        <div className="space-y-2">
          {stale && (
            <p id={staleId} className="text-sm text-amber-900 dark:text-amber-200">
              {t('admin.apps.conversation.change.stale')}
            </p>
          )}
          {savesOtherChanges && (
            <p
              id={alsoSavesId}
              data-testid="change-also-saves"
              className="text-sm text-gray-700 dark:text-gray-300"
            >
              {t('admin.apps.conversation.change.alsoSaves')}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={onDismiss}
              disabled={status === 'applying'}
            >
              {t('admin.apps.conversation.change.dismiss')}
            </button>
            <button
              type="button"
              className={PRIMARY_BUTTON_CLASS}
              onClick={() => onApply(ticked)}
              disabled={stale || status === 'applying'}
              aria-describedby={applyDescription}
            >
              {status === 'applying'
                ? t('admin.apps.conversation.change.applying')
                : t('admin.apps.conversation.change.apply')}
            </button>
          </div>
        </div>
      )}

      {status === 'dismissed' && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('admin.apps.conversation.change.dismissed')}
        </p>
      )}

      {(status === 'applied' || status === 'undoing' || status === 'kept') && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p
              ref={appliedRef}
              tabIndex={-1}
              data-testid="change-applied"
              className="flex items-center gap-1.5 rounded-sm text-sm font-medium text-green-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:text-green-200"
            >
              <Icon name="check-circle" size="sm" aria-hidden="true" />
              {testOpen
                ? t('admin.apps.conversation.change.appliedTest')
                : t('admin.apps.conversation.change.applied')}
            </p>
            {status !== 'kept' && (
              <button
                type="button"
                className={LINK_BUTTON_CLASS}
                onClick={onUndo}
                disabled={!undoAvailable || status === 'undoing'}
                aria-describedby={
                  undoAvailable ? (savesOtherChanges ? alsoSavesId : undefined) : undoBlockedId
                }
              >
                {status === 'undoing'
                  ? t('admin.apps.conversation.change.undoing')
                  : t('admin.apps.conversation.change.undo')}
              </button>
            )}
          </div>
          {status === 'applied' && !undoAvailable && (
            <p id={undoBlockedId} className="text-sm text-gray-600 dark:text-gray-400">
              {t('admin.apps.conversation.change.undoChanged')}
            </p>
          )}
          {status === 'applied' && undoAvailable && savesOtherChanges && (
            <p
              id={alsoSavesId}
              data-testid="change-undo-also-saves"
              className="text-sm text-gray-600 dark:text-gray-400"
            >
              {t('admin.apps.conversation.change.undoAlsoSaves')}
            </p>
          )}
          {status === 'applied' && entry.problem === 'conflict' && (
            <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-200">
              {t('admin.apps.conversation.change.conflict')}
            </p>
          )}
          {status === 'applied' && entry.problem === 'failed' && (
            <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-200">
              {t('admin.apps.conversation.change.failed', { detail: entry.problemText || '' })}
            </p>
          )}
        </div>
      )}

      {status === 'undone' && (
        <p
          ref={appliedRef}
          tabIndex={-1}
          data-testid="change-undone"
          className="rounded-sm text-sm font-medium text-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:text-gray-300"
        >
          {t('admin.apps.conversation.change.undone')}
        </p>
      )}
    </article>
  );
}

export default ChangeCard;
