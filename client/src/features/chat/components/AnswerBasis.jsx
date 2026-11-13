// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { usePopoverPanel } from '../hooks/usePopoverPanel';
import { ProvenanceDetails } from './ProvenanceInfo';
import ProviderMark from './ProviderMark';
import {
  KIND_ICON,
  basisEntries,
  basisPhrase,
  chipAccessibleName,
  chipParts,
  entryLabel,
  isModelOnly,
  isUserProject,
  isWorkflowOnly,
  projectDiagnostics,
  projectModeText,
  projectName,
  splitScope,
  unusedReason
} from './answerBasisModel';

/**
 * The tone of the chip: indigo when sources were used, gray for the model's own
 * knowledge. Outlined, because the chip can be clicked (#3521). The colour does
 * not tell the kinds apart: the icon and the noun do.
 */
const CHIP_TONE = {
  info: 'border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-900/30',
  neutral:
    'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'
};

const SECTION_HEADING = 'mb-1 text-xs font-semibold text-gray-900 dark:text-gray-100';
const MUTED = 'text-gray-500 dark:text-gray-400';

/** One section of the popover, named by its heading. */
function Section({ title, children, testId }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid={testId} className="mt-3">
      <h4 id={headingId} className={SECTION_HEADING}>
        {title}
      </h4>
      {children}
    </section>
  );
}

/** A project that contributed: its name, how it was used, the way to open it, its diagnostics. */
function UsedProject({ project, t }) {
  const name = projectName(project, t);
  const diagnostics = projectDiagnostics(project, t);
  return (
    <li className="flex flex-col gap-0.5" data-testid="answer-basis-project">
      <span className="font-medium text-gray-900 dark:text-gray-100">{name}</span>
      <span className={MUTED}>{projectModeText(project, t)}</span>
      {diagnostics.length > 0 && (
        <span className={MUTED} data-testid="answer-basis-diagnostics">
          {diagnostics.join(' · ')}
        </span>
      )}
      {isUserProject(project) && (
        <Link
          to={`/projects/${encodeURIComponent(project.id)}`}
          aria-label={t('chatMessage.answerBasis.openProjectNamed', 'Open project {{name}}', {
            name
          })}
          className="inline-flex w-fit items-center gap-1 text-indigo-600 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-400"
        >
          {t('chatMessage.answerBasis.openProject', 'Open project')}
          <Icon name="external-link" className="h-3 w-3 shrink-0" />
        </Link>
      )}
    </li>
  );
}

/** The sources section: every kind the answer used, a project by the projects behind it. */
function SourcesList({ entries, used, workflowResult, language, t }) {
  const items = [];
  for (const entry of entries) {
    if (entry.kind === 'project') {
      if (used.length > 0) {
        used.forEach(project =>
          items.push(<UsedProject key={project.id} project={project} t={t} />)
        );
        continue;
      }
    }
    if (entry.kind === 'workflow') {
      items.push(
        <WorkflowSource key="workflow" workflowResult={workflowResult} language={language} t={t} />
      );
      continue;
    }
    items.push(
      <li key={`${entry.kind}:${entry.label || ''}`} className="text-gray-900 dark:text-gray-100">
        {entry.kind === 'integration' && entry.label
          ? t('chatMessage.answerBasis.source.integrationNamed', 'Connected system: {{name}}', {
              name: entry.label
            })
          : t(`chatMessage.answerBasis.source.${entry.kind}`, entryLabel(entry, t))}
      </li>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="answer-basis-sources">
      {items}
    </ul>
  );
}

/** The workflow run behind the answer, with the way to its execution. */
function WorkflowSource({ workflowResult, language, t }) {
  // The name in the reader's language, else the default language, else any it has.
  const name = getLocalizedContent(workflowResult?.workflowName, language) || null;
  return (
    <li className="flex flex-col gap-0.5" data-testid="answer-basis-workflow">
      <span className="font-medium text-gray-900 dark:text-gray-100">
        {name || t('chatMessage.answerBasis.kind.workflow', 'Workflow')}
      </span>
      {workflowResult?.executionId && (
        <Link
          to={`/workflows/executions/${workflowResult.executionId}`}
          className="inline-flex w-fit items-center gap-1 text-indigo-600 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-400"
        >
          {t('chatMessage.answerBasis.openExecution', 'Open workflow execution')}
          <Icon name="external-link" className="h-3 w-3 shrink-0" />
        </Link>
      )}
    </li>
  );
}

/** The projects in scope that the answer did not use, each with its reason. */
function NotUsedList({ projects, t }) {
  // A project a shared chat does not name has no id: its key counts the ones before it.
  const seen = new Map();
  const keyed = projects.map(project => {
    const base = project.id ?? 'private';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { project, key: `${base}:${n}` };
  });
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="answer-basis-not-used">
      {keyed.map(({ project, key }) => (
        <li key={key} className="flex flex-col gap-0.5">
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {projectName(project, t)}
          </span>
          <span className={MUTED}>{unusedReason(project, t)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The AI-generated records of the answer: its text's and one per picture, each as the
 * server sent it. A picture without the object (stored before it existed) has none.
 *
 * @returns {Array<{key: string, kind: 'text'|'image', number?: number, provenance: Object,
 *   artifactId?: string}>}
 */
function provenanceRecords(provenance, images) {
  const records = [];
  if (provenance?.ai_generated) records.push({ key: 'text', kind: 'text', provenance });
  (Array.isArray(images) ? images : []).forEach((image, index) => {
    if (image?.provenance?.ai_generated) {
      records.push({
        key: `image-${index}`,
        kind: 'image',
        number: index + 1,
        provenance: image.provenance,
        // The stored picture, for what its file itself carries. A picture only just
        // generated has no artifact id yet; it gets the row once the chat is reopened.
        artifactId: image.id
      });
    }
  });
  return records;
}

/**
 * "About this answer": what the answer is, what it is based on, what was left
 * out, and the record of it. A non-modal dialog like the other disclosures:
 * Escape closes it and returns the focus to the chip.
 */
function BasisPopover({
  entries,
  scope,
  workflowResult,
  provenance,
  images,
  chatId,
  models,
  panelProps
}) {
  const { t, i18n } = useTranslation();
  const { panelRef } = panelProps;
  // The popover is a dialog, so opening it moves the focus into it: a keyboard or screen
  // reader user lands on its title and reads on. It is not a trap: Tab leaves it, Escape
  // closes it and the focus returns to the chip (`usePopoverPanel`). After the hook's
  // positioning (a layout effect), so the panel is not scrolled into place.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [panelRef]);
  const { used, unused } = splitScope(scope);
  const records = provenanceRecords(provenance, images);
  const titleId = useId();
  const modelOnly = isModelOnly(entries);
  const isWorkflow = isWorkflowOnly(entries);
  let sentence;
  if (isWorkflow) {
    sentence = t(
      'chatMessage.answerBasis.sentenceWorkflow',
      'This answer was generated by AI in a workflow.'
    );
  } else if (modelOnly) {
    sentence = t(
      'chatMessage.answerBasis.sentenceModel',
      "This answer was generated by AI, based on the model's knowledge."
    );
  } else {
    sentence = t(
      'chatMessage.answerBasis.sentence',
      'This answer was generated by AI, based on {{what}}.',
      { what: basisPhrase(entries, t, i18n?.language) }
    );
  }

  return (
    <div
      ref={panelProps.panelRef}
      id={panelProps.panelId}
      tabIndex={-1}
      style={panelProps.panelStyle}
      role="dialog"
      aria-labelledby={titleId}
      data-testid="answer-basis-panel"
      className={`absolute ${panelProps.side === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2'} end-0 z-20 w-80 max-h-[70vh] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 border-gray-200 bg-white p-3 text-start text-xs font-normal shadow-lg dark:border-gray-700 dark:bg-gray-900`}
    >
      <h3 id={titleId} className="m-0 text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('chatMessage.answerBasis.title', 'About this answer')}
      </h3>

      <Section
        title={t('chatMessage.answerBasis.aiGenerated', 'AI-generated')}
        testId="answer-basis-ai"
      >
        <p className="m-0 text-gray-700 dark:text-gray-300">{sentence}</p>
      </Section>

      {!modelOnly && (
        <Section title={t('chatMessage.answerBasis.sources', 'Sources')}>
          <SourcesList
            entries={entries}
            used={used}
            workflowResult={workflowResult}
            language={i18n?.language}
            t={t}
          />
        </Section>
      )}

      {unused.length > 0 && (
        <Section title={t('chatMessage.answerBasis.notUsed', 'Not used')}>
          <NotUsedList projects={unused} t={t} />
        </Section>
      )}

      {records.length > 0 && (
        <Section
          title={t('chatMessage.answerBasis.details', 'Details')}
          testId="answer-basis-details"
        >
          {/* One record per output. Named only when there is more than one to tell apart. */}
          <div className="flex flex-col gap-3">
            {records.map(record => (
              <div key={record.key} data-testid={`answer-basis-record-${record.kind}`}>
                {records.length > 1 && (
                  <p className="m-0 mb-1 font-medium text-gray-900 dark:text-gray-100">
                    {record.kind === 'image'
                      ? t('chatMessage.answerBasis.detailsImage', 'Image {{number}}', {
                          number: record.number
                        })
                      : t('chatMessage.answerBasis.detailsText', 'Text')}
                  </p>
                )}
                <ProvenanceDetails
                  provenance={record.provenance}
                  models={models}
                  extra={
                    record.artifactId ? (
                      <ProviderMark chatId={chatId} artifactId={record.artifactId} />
                    ) : null
                  }
                />
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/**
 * The one chip that says the answer is AI-generated and what it is based on:
 * a fixed "AI-generated" segment, then the kinds of source it used (no names or
 * modes). "Based on" lives in the popover sentence, not the chip, to keep the
 * chip narrow. Opening it shows "About this answer".
 */
function BasisChip({
  entries,
  scope,
  workflowResult,
  provenance,
  images,
  chatId,
  models,
  className = ''
}) {
  const { t, i18n } = useTranslation();
  const popover = usePopoverPanel('top');
  const { open, setOpen, panelId, rootRef, buttonRef } = popover;
  const { named, more } = chipParts(entries);
  const tone = isModelOnly(entries) ? CHIP_TONE.neutral : CHIP_TONE.info;
  // Two or more kinds drop their nouns on a narrow pane: the icons stay and the
  // accessible name keeps the full text. A single kind is short enough to stay.
  const nounClass = entries.length > 1 ? '@max-sm:sr-only' : '';

  return (
    <div className={`relative inline-flex min-w-0 max-w-full ${className}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        aria-label={chipAccessibleName(entries, t, i18n?.language)}
        data-testid="answer-basis-chip"
        className={`inline-flex h-6 min-w-0 max-w-full items-center overflow-hidden whitespace-nowrap rounded-full border bg-white text-xs shadow-xs focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 dark:bg-gray-800 dark:focus-visible:ring-offset-gray-900 ${tone}`}
      >
        {/* The AI statement: the same on every answer, so it is the first thing read and
            never the part that is skipped. Text, not only an icon. On a narrow pane it is
            short ("AI"), never dropped. */}
        <span
          data-testid="answer-basis-ai-label"
          className="inline-flex h-full shrink-0 items-center gap-1 border-e border-indigo-200 bg-indigo-50 ps-2 pe-1.5 font-medium text-indigo-700 dark:border-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300"
        >
          <Icon name="sparkles" className="h-3 w-3 shrink-0" />
          <span className="@max-sm:hidden">
            {t('chatMessage.answerBasis.aiGenerated', 'AI-generated')}
          </span>
          <span aria-hidden="true" className="hidden @max-sm:inline">
            {t('chatMessage.answerBasis.aiShort', 'AI')}
          </span>
        </span>
        <span
          data-testid="answer-basis-kinds"
          className="inline-flex h-full min-w-0 items-center gap-1.5 ps-1.5 pe-1.5"
        >
          {named.map((entry, index) => (
            <span
              key={`${entry.kind}:${entry.label || ''}`}
              className="inline-flex min-w-0 items-center gap-1"
            >
              {index > 0 && (
                <span aria-hidden="true" className={nounClass ? '@max-sm:hidden' : undefined}>
                  ·
                </span>
              )}
              <Icon name={KIND_ICON[entry.kind] || 'link'} className="h-3 w-3 shrink-0" />
              <span className={`truncate ${nounClass}`}>{entryLabel(entry, t)}</span>
            </span>
          ))}
          {more > 0 && (
            <span data-testid="answer-basis-more">
              {t('chatMessage.answerBasis.more', '+{{count}}', { count: more })}
            </span>
          )}
          <Icon
            name="chevron-down"
            className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>
      {open && (
        <BasisPopover
          entries={entries}
          scope={scope}
          workflowResult={workflowResult}
          provenance={provenance}
          images={images}
          chatId={chatId}
          models={models}
          panelProps={popover}
        />
      )}
    </div>
  );
}

/**
 * The amber chip for the projects the turn was told about and could not read: a
 * failure, so it stays apart from the basis and is said once. The names and the
 * reason are in its text for a screen reader, and under "Not used" in the popover.
 * `role="status"` only on the newest answer, so history does not announce itself.
 */
function UnavailableChip({ projects, newest, t }) {
  const names = projects.map(project => projectName(project, t));
  const why = projects.some(project => project.reason === 'IFINDER_UNAVAILABLE')
    ? t(
        'chatMessage.knowledgeScope.missingIFinder',
        'iFinder could not be reached, so this answer did not use it.'
      )
    : t('chatMessage.knowledgeScope.missingOther', 'This answer did not use it.');
  return (
    <span
      role={newest ? 'status' : undefined}
      data-testid="knowledge-scope-missing"
      className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-100 px-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
    >
      <Icon name="exclamation-triangle" className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {t('chatMessage.answerBasis.unavailable', { count: projects.length })}
      </span>
      <span className="sr-only">{`: ${names.join(', ')}. ${why}`}</span>
    </span>
  );
}

/**
 * What the answer is based on, in the footer row under it: the basis chip, and
 * the amber chip when a project in scope could not be used. Both are items of the
 * row; `className` goes on the basis chip (`ms-auto` pushes it to the row's end).
 *
 * Both are drawn from what the server sent — `run/ended.answerBasis` and
 * `knowledge/scope` — and nothing is inferred here. A message stored without
 * `answerBasis` has no chip; a failed turn or one stopped before it wrote
 * anything has none either.
 *
 * @param {Object} props
 * @param {Array<{kind: string, label?: string}>} [props.answerBasis] - `run/ended.answerBasis`
 * @param {Object} [props.workflowResult] - Set when a workflow run produced the answer
 * @param {Object} [props.knowledgeScope] - `knowledge/scope`: the projects and what each contributed
 * @param {Object} [props.provenance] - The server's provenance object, for the popover's details
 * @param {Array<Object>} [props.images] - The pictures of the answer, each with its own
 *   `provenance`: their details are in the same popover
 * @param {string} [props.chatId] - The chat, to ask what a stored picture's file carries
 * @param {Array<Object>} [props.models] - Model list, for the model's display name
 * @param {boolean} [props.newest=false] - Whether this is the newest answer of the chat
 */
function AnswerBasis({
  answerBasis,
  workflowResult,
  knowledgeScope,
  provenance,
  images,
  chatId,
  models,
  newest = false,
  className = ''
}) {
  const { t } = useTranslation();
  const entries = basisEntries(answerBasis, workflowResult);
  const { unavailable } = splitScope(knowledgeScope);
  if (entries.length === 0 && unavailable.length === 0) return null;
  // Two siblings of the footer row, not one box around them: the amber chip wraps to its
  // own line on a narrow pane, and the basis chip stays beside the results entry.
  return (
    <>
      {entries.length > 0 && (
        <BasisChip
          className={className}
          entries={entries}
          scope={knowledgeScope}
          workflowResult={workflowResult}
          provenance={provenance}
          images={images}
          chatId={chatId}
          models={models}
        />
      )}
      {unavailable.length > 0 && <UnavailableChip projects={unavailable} newest={newest} t={t} />}
    </>
  );
}

export default AnswerBasis;
