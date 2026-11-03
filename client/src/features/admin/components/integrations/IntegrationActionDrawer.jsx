// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Drawer from '../../../../shared/components/Drawer';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';
import LoadingSpinner from '../../../../shared/components/LoadingSpinner';
import { DATA_FLOWS, SIDE_EFFECTS } from '../../../../../../shared/toolApproval.js';
import {
  fetchIntegrationAction,
  markInstalledIntegrationActionsReviewed,
  saveIntegrationActionOverride,
  setInstalledIntegrationApproval
} from '../../../../api/integrationsAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import { ApprovalModeSelect, approvalModeLabel } from '../ToolApprovalFields';
import {
  CALLOUT_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';
import { SideEffectBadge } from './ActionToggleList';
import ActionReviewBadge from './ActionReviewBadge';
import ActionTestPanel from './ActionTestPanel';
import { approvalPayload, normalizeApproval, withActionMode } from './installationApproval';
import {
  baseLanguage,
  textInLanguage,
  withLanguageExamples,
  withLanguageText
} from './actionTestForm';

const SECTION_CLASS = 'border-b border-gray-200 py-6 last:border-b-0 dark:border-gray-700';
const SECTION_TITLE_CLASS = 'text-base font-semibold text-gray-900 dark:text-gray-100';
const SECTION_LEAD_CLASS = 'mb-4 mt-1 text-sm text-gray-600 dark:text-gray-400';
const FIELD_LABEL_CLASS = 'text-sm font-semibold text-gray-900 dark:text-gray-100';
const VALUE_BOX_CLASS =
  'mt-1.5 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200';
const LINK_CLASS =
  'rounded-sm text-indigo-700 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300';
const TEXT_BUTTON_CLASS =
  'rounded-sm px-1 text-xs font-medium text-indigo-700 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50 dark:text-indigo-300';

/**
 * Where a value came from, as the admin reads it.
 * @param {Function} t
 * @param {string} source - a `sideEffectSource`, `dataFlowSource` or `approvalSource`
 * @returns {string}
 */
export function sourceLabel(t, source) {
  if (typeof source === 'string' && source.startsWith('platform')) {
    return t('admin.integrations.actionDetail.source.platform', 'platform default');
  }
  switch (source) {
    case 'admin':
      return t('admin.integrations.actionDetail.source.admin', 'admin override');
    case 'definition':
      return t('admin.integrations.actionDetail.source.definition', 'integration definition');
    case 'annotation':
      return t(
        'admin.integrations.actionDetail.source.annotation',
        'vendor annotation (not trusted)'
      );
    case 'protocol':
      return t(
        'admin.integrations.actionDetail.source.protocol',
        'remote system (always external)'
      );
    case 'tool':
      return t('admin.integrations.actionDetail.source.tool', 'tool');
    case 'installation':
      return t('admin.integrations.actionDetail.source.installation', 'integration setting');
    case 'action':
      return t('admin.integrations.actionDetail.source.action', 'this action’s setting');
    case 'newOrChanged':
      return t(
        'admin.integrations.actionDetail.source.newOrChanged',
        'new or changed since the last review'
      );
    case 'app':
      return t('admin.integrations.actionDetail.source.app', 'app');
    default:
      return t('admin.integrations.actionDetail.source.default', 'default');
  }
}

/**
 * A text the admin can override: shown as it applies, with Edit, Save, Reset.
 * @param {Object} props
 * @param {string} props.label - the field's name
 * @param {string} props.value - the effective text
 * @param {boolean} props.overridden - an admin override applies
 * @param {string} props.editValue - the override in the current language
 * @param {string} [props.help]
 * @param {string} [props.placeholder] - shown when there is no text
 * @param {boolean} [props.multiline]
 * @param {boolean} props.busy
 * @param {(text: string) => Promise<void>} props.onSave
 * @param {() => Promise<void>} props.onReset
 * @param {string} props.testId
 */
function EditableText({
  label,
  value,
  overridden,
  editValue,
  help,
  placeholder,
  busy,
  onSave,
  onReset,
  testId
}) {
  const { t } = useTranslation();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const start = () => {
    setDraft(editValue || value || '');
    setEditing(true);
  };

  return (
    <div data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={FIELD_LABEL_CLASS}>{label}</span>
        {overridden && (
          <Badge tone="accent" shape="rounded">
            {t('admin.integrations.actionDetail.edited', 'Edited')}
          </Badge>
        )}
        {!editing && (
          <button type="button" className={TEXT_BUTTON_CLASS} onClick={start} disabled={busy}>
            {t('common.edit', 'Edit')}
            <span className="sr-only">: {label}</span>
          </button>
        )}
        {!editing && overridden && (
          <button type="button" className={TEXT_BUTTON_CLASS} onClick={onReset} disabled={busy}>
            {t('admin.integrations.actionDetail.reset', 'Reset to default')}
            <span className="sr-only">: {label}</span>
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="mt-1"
          onSubmit={async event => {
            event.preventDefault();
            await onSave(draft);
            setEditing(false);
          }}
        >
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <textarea
            id={id}
            className={INPUT_CLASS}
            rows={4}
            value={draft}
            disabled={busy}
            onChange={e => setDraft(e.target.value)}
            aria-describedby={help ? `${id}-help` : undefined}
          />
          {help && (
            <p id={`${id}-help`} className={HELP_CLASS}>
              {help}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button type="submit" className={PRIMARY_BUTTON_CLASS} disabled={busy}>
              {t('common.save', 'Save')}
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </form>
      ) : value ? (
        <p className={`${VALUE_BOX_CLASS} whitespace-pre-wrap`}>{value}</p>
      ) : (
        <p className="mt-1.5 text-sm italic text-gray-600 dark:text-gray-400">{placeholder}</p>
      )}
    </div>
  );
}

/**
 * The parameters of an action as a table, plus the schema exactly as sent.
 * @param {Object} props
 * @param {Object} props.schema
 */
function ParameterTable({ schema }) {
  const { t } = useTranslation();
  const properties =
    schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const names = Object.keys(properties);
  return (
    <div>
      {names.length === 0 ? (
        <p className={HELP_CLASS}>
          {t('admin.integrations.actionDetail.test.noParameters', 'This action takes no input.')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200 px-3 py-1 dark:border-gray-700">
          <table className="min-w-full text-left text-sm" data-testid="action-parameters">
            <caption className="sr-only">
              {t('admin.integrations.actionDetail.parameters', 'Parameters')}
            </caption>
            <thead>
              <tr className="text-xs text-gray-600 dark:text-gray-400">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('admin.integrations.actionDetail.paramName', 'Name')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('admin.integrations.actionDetail.paramType', 'Type')}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {t('admin.integrations.actionDetail.paramDescription', 'Description')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {names.map(name => {
                const property = properties[name] || {};
                const type = Array.isArray(property.type)
                  ? property.type.join(' | ')
                  : property.type || (property.enum ? 'enum' : '—');
                return (
                  <tr key={name} className="align-top text-gray-800 dark:text-gray-200">
                    <td className="py-1 pr-3 font-mono text-xs">
                      {name}
                      {required.has(name) && (
                        <span className="ml-1 text-xs text-red-700 dark:text-red-400">
                          {t('admin.integrations.actionDetail.paramRequired', 'required')}
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-3 font-mono text-xs">{type}</td>
                    <td className="py-1 text-xs">{property.description || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer rounded-sm text-xs font-medium text-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-300">
          {t('admin.integrations.actionDetail.schemaAsSent', 'Schema as sent to the model')}
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:bg-gray-950 dark:text-gray-200">
          {JSON.stringify(schema, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/**
 * A select for an admin override of a side effect or data flow; the empty
 * option keeps what the vendor declared.
 */
function OverrideSelect({
  label,
  help,
  value,
  options,
  optionLabel,
  inheritLabel,
  disabled,
  onChange
}) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <select
        id={id}
        aria-describedby={help ? helpId : undefined}
        className={INPUT_CLASS}
        value={value || ''}
        disabled={disabled}
        onChange={e => onChange(e.target.value || null)}
      >
        <option value="">{inheritLabel}</option>
        {options.map(option => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
      {help && (
        <p id={helpId} className={HELP_CLASS}>
          {help}
        </p>
      )}
    </div>
  );
}

/**
 * The action detail (#2974, product concept §6.5a): one drawer per action of
 * an installation with five sections.
 *
 * - **What it does**: the description and parameter schema exactly as the
 *   model sees them; the description can be overridden.
 * - **Side effect, data flow, approval**: badges and where each value came
 *   from (vendor annotation, OpenAPI method, admin override, definition); the
 *   admin overrides; the action's approval mode and its review state (#2916).
 * - **How to use**: model guidance (added to the system prompt while the
 *   integration is active), example prompts, and the apps, workflows and
 *   scheduled tasks that bind the action.
 * - **Test**: `ActionTestPanel`.
 * - **Usage**: calls, approvals, rejections and errors in the last 7 days.
 *
 * Every change is saved on its own (override, approval, review) and reloads
 * the detail; `onChanged` lets the page reload its list.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {string} props.instanceId
 * @param {string|null} props.actionName - the action to show
 * @param {Object|null} props.approval - the installation's stored `approval`
 * @param {string} [props.userName] - the acting admin, for the test's connection label
 * @param {() => void} [props.onChanged] - something was saved
 * @param {() => void} [props.onTryInChat] - open the chat test of the installation
 * @returns {JSX.Element}
 */
function IntegrationActionDrawer({
  isOpen,
  onClose,
  instanceId,
  actionName,
  approval,
  userName = '',
  onChanged,
  onTryInChat
}) {
  const { t, i18n } = useTranslation();
  const lang = baseLanguage(i18n.language);
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    if (!actionName) return;
    setLoadError(null);
    try {
      setDetail(await fetchIntegrationAction(instanceId, actionName));
    } catch (err) {
      setLoadError(getAdminApiErrorMessage(err));
    }
  }, [instanceId, actionName]);

  // The page mounts one drawer per action (`key`), so the state starts empty.
  useEffect(() => {
    void load();
  }, [load]);

  /** Run a save, show its outcome, reload the detail and tell the page. */
  const save = async (work, successText) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await work();
      if (next) setDetail(next);
      else await load();
      setMessage({ type: 'success', text: successText });
      onChanged?.();
    } catch (err) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const saveOverride = (patch, successText) =>
    save(
      async () => (await saveIntegrationActionOverride(instanceId, actionName, patch)).detail,
      successText || t('admin.integrations.actionDetail.saved', 'Saved.')
    );

  const saveActionMode = mode =>
    save(
      async () => {
        const draft = withActionMode(normalizeApproval(approval), actionName, mode);
        await setInstalledIntegrationApproval(instanceId, approvalPayload(draft));
        return null;
      },
      t('admin.toolApproval.installationSaved', 'Approval settings saved.')
    );

  const markReviewed = () =>
    save(
      async () => {
        await markInstalledIntegrationActionsReviewed(instanceId, [actionName]);
        return null;
      },
      t('admin.integrations.actionReview.marked', 'Marked as reviewed: {{actions}}', {
        actions: actionName
      })
    );

  const effectLabel = effect => t(`admin.integrationCatalog.sideEffect.${effect}`, effect);
  const flowLabel = flow => t(`admin.integrations.actionDetail.dataFlow.${flow}`, flow);

  const title = detail
    ? `${detail.installation.label} › ${detail.action.title}`
    : t('admin.integrations.actionDetail.title', 'Action');

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      bodyClassName="px-5 py-4"
      title={title}
      description={detail ? <span className="font-mono">{detail.action.toolId}</span> : undefined}
      icon={<Icon name="wrench" className="h-5 w-5 text-indigo-500" />}
      data-testid="integration-action-drawer"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {onTryInChat && (
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={onTryInChat}
              data-testid="action-try-in-chat"
            >
              <Icon name="beaker" size="sm" />
              {t('admin.integrations.actionDetail.tryInChat', 'Try in chat')}
            </button>
          )}
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
        </div>
      }
    >
      {loadError && <p className={CALLOUT_CLASS.danger}>{loadError}</p>}
      {!detail && !loadError && (
        <div className="flex justify-center py-10">
          <LoadingSpinner size="md" />
        </div>
      )}
      {detail && (
        <div>
          <div aria-live="polite">
            {message && (
              <p
                className={`mb-2 ${message.type === 'error' ? CALLOUT_CLASS.danger : CALLOUT_CLASS.success}`}
              >
                {message.text}
              </p>
            )}
          </div>
          <p className={`mb-3 ${CALLOUT_CLASS.info}`} data-testid="action-intro">
            {t(
              'admin.integrations.actionDetail.intro',
              'This is one action of the integration: a single thing the AI model can ask this system to do. Here you control what the model is told about it, how iHub treats it (read or write, where the data goes, whether a person must approve) and you can run it once to see that it works.'
            )}
          </p>
          <div className="flex flex-wrap items-center gap-1.5" data-testid="action-badges">
            <span className="mr-1 text-xs font-medium text-gray-600 dark:text-gray-400">
              {t('admin.integrations.actionDetail.badgesLabel', 'Current settings:')}
            </span>
            <ActionReviewBadge review={detail.action.review} />
            <SideEffectBadge sideEffect={detail.effect.sideEffect} />
            <Badge
              tone={detail.effect.dataFlow === 'external' ? 'highlight' : 'neutral'}
              shape="rounded"
            >
              {flowLabel(detail.effect.dataFlow)}
            </Badge>
            <Badge tone={detail.approval.mode === 'never' ? 'neutral' : 'warning'} shape="rounded">
              {approvalModeLabel(t, detail.approval.mode)}
            </Badge>
            {!detail.action.enabled && (
              <Badge tone="neutral" shape="rounded">
                {t('admin.integrations.page.actionOff', 'Off')}
              </Badge>
            )}
          </div>

          <section className={SECTION_CLASS} aria-labelledby="action-what-title">
            <h3 id="action-what-title" className={SECTION_TITLE_CLASS}>
              {t('admin.integrations.actionDetail.what', 'What it does')}
            </h3>
            <p className={SECTION_LEAD_CLASS}>
              {t(
                'admin.integrations.actionDetail.whatLead',
                'What the AI model is told about this action. It reads the description and the parameters to decide when to call it and what to pass.'
              )}
            </p>
            <EditableText
              testId="action-description"
              label={t(
                'admin.integrations.actionDetail.modelDescription',
                'Description for the model'
              )}
              value={detail.action.description}
              overridden={detail.action.overridden.description}
              editValue={textInLanguage(detail.action.overrideTexts.description, lang)}
              help={t(
                'admin.integrations.actionDetail.modelDescriptionHelp',
                'The tool description the model reads to decide when to call this action. Saved for the current language.'
              )}
              busy={busy}
              onSave={text =>
                saveOverride({
                  description: withLanguageText(detail.action.overrideTexts.description, lang, text)
                })
              }
              onReset={() => saveOverride({ description: null })}
            />
            <div className="mt-4">
              <span className={`mb-1.5 block ${FIELD_LABEL_CLASS}`}>
                {t('admin.integrations.actionDetail.parameters', 'Parameters')}
              </span>
              <ParameterTable schema={detail.action.parameters} />
            </div>
          </section>

          <section className={SECTION_CLASS} aria-labelledby="action-effect-title">
            <h3 id="action-effect-title" className={SECTION_TITLE_CLASS}>
              {t('admin.integrations.actionDetail.effect', 'Side effect, data flow, approval')}
            </h3>
            <p className={SECTION_LEAD_CLASS}>
              {t(
                'admin.integrations.actionDetail.effectLead',
                'How iHub treats a call to this action. These values decide whether a person has to approve it first. The vendor’s declaration is not trusted on its own; your overrides are.'
              )}
            </p>
            <dl
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800"
              data-testid="action-effect-sources"
            >
              <dt className="font-medium text-gray-900 dark:text-gray-100">
                {t('admin.integrations.actionDetail.sideEffect', 'Side effect')}
              </dt>
              <dd className="text-gray-800 dark:text-gray-200">
                {effectLabel(detail.effect.sideEffect)} ·{' '}
                {t('admin.integrations.actionDetail.from', 'from {{source}}', {
                  source: sourceLabel(t, detail.effect.sideEffectSource)
                })}
              </dd>
              <dt className="font-medium text-gray-900 dark:text-gray-100">
                {t('admin.integrations.actionDetail.dataFlowLabel', 'Data flow')}
              </dt>
              <dd className="text-gray-800 dark:text-gray-200">
                {flowLabel(detail.effect.dataFlow)} ·{' '}
                {t('admin.integrations.actionDetail.from', 'from {{source}}', {
                  source: sourceLabel(t, detail.effect.dataFlowSource)
                })}
              </dd>
              <dt className="font-medium text-gray-900 dark:text-gray-100">
                {t('admin.integrations.actionDetail.approval', 'Approval')}
              </dt>
              <dd className="text-gray-800 dark:text-gray-200">
                {approvalModeLabel(t, detail.approval.mode)} ·{' '}
                {t('admin.integrations.actionDetail.from', 'from {{source}}', {
                  source: sourceLabel(t, detail.approval.source)
                })}
              </dd>
            </dl>
            {detail.effect.methodSideEffect &&
              detail.effect.declaredSideEffect === 'unknown' &&
              !detail.effect.override.sideEffect && (
                <p className={`mt-2 ${HELP_CLASS}`} data-testid="action-method-hint">
                  {t(
                    'admin.integrations.actionDetail.methodHint',
                    'The OpenAPI method {{method}} suggests “{{effect}}”. Confirm it with an override below.',
                    {
                      method: detail.action.httpMethod,
                      effect: effectLabel(detail.effect.methodSideEffect)
                    }
                  )}
                </p>
              )}
            <h4 className="mb-2 mt-5 text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.integrations.actionDetail.overridesTitle', 'Change these settings')}
            </h4>
            <div className="space-y-4">
              <OverrideSelect
                label={t(
                  'admin.integrations.actionDetail.overrideSideEffect',
                  'Side effect override'
                )}
                help={t(
                  'admin.integrations.actionDetail.sideEffectHelp',
                  'What a call changes in the connected system: nothing (read), something (write) or it deletes data.'
                )}
                value={detail.effect.override.sideEffect}
                options={SIDE_EFFECTS}
                optionLabel={effectLabel}
                inheritLabel={t(
                  'admin.integrations.actionDetail.asDeclared',
                  'As declared ({{value}})',
                  {
                    value: effectLabel(detail.effect.declaredSideEffect || 'unknown')
                  }
                )}
                disabled={busy}
                onChange={value => saveOverride({ sideEffect: value })}
              />
              <OverrideSelect
                label={t('admin.integrations.actionDetail.overrideDataFlow', 'Data flow override')}
                help={t(
                  'admin.integrations.actionDetail.dataFlowHelp',
                  'Whether the result stays inside iHub or is sent on to an outside service.'
                )}
                value={detail.effect.override.dataFlow}
                options={DATA_FLOWS}
                optionLabel={flowLabel}
                inheritLabel={t('admin.integrations.actionDetail.asDeclaredPlain', 'As declared')}
                disabled={busy}
                onChange={value => saveOverride({ dataFlow: value })}
              />
              <ApprovalModeSelect
                label={t(
                  'admin.integrations.actionDetail.actionApproval',
                  'Approval for this action'
                )}
                value={detail.approval.actionMode || undefined}
                inheritLabel={t(
                  'admin.toolApproval.inheritInstallation',
                  'Approval: as the integration'
                )}
                help={t(
                  'admin.integrations.actionDetail.approvalHelp',
                  'Whether a person has to confirm each call to this action in the chat before it runs.'
                )}
                modes={['writes', 'always']}
                disabled={busy}
                onChange={saveActionMode}
              />
            </div>
            <p className={`mt-4 ${HELP_CLASS}`}>
              {t(
                'admin.integrations.actionDetail.effectHelp',
                'An override is your decision and is trusted: it can make a gate stricter or, for a confirmed read, looser. The strictest of the platform default, the integration, this action and the app wins.'
              )}
            </p>
            {detail.action.review && (
              <div
                className={`mt-3 flex flex-wrap items-center justify-between gap-2 ${CALLOUT_CLASS.warning}`}
              >
                <span>
                  {detail.action.review === 'new'
                    ? t(
                        'admin.integrations.actionReview.newHint',
                        'Added since the last review. It asks for approval until you mark it reviewed.'
                      )
                    : t(
                        'admin.integrations.actionReview.changedHint',
                        'Its side effect or input changed since the last review. It asks for approval until you mark it reviewed.'
                      )}
                </span>
                <button
                  type="button"
                  className={SECONDARY_BUTTON_CLASS}
                  onClick={markReviewed}
                  disabled={busy}
                >
                  {t('admin.integrations.actionReview.markOne', 'Mark reviewed')}
                </button>
              </div>
            )}
          </section>

          <section className={SECTION_CLASS} aria-labelledby="action-use-title">
            <h3 id="action-use-title" className={SECTION_TITLE_CLASS}>
              {t('admin.integrations.actionDetail.howToUse', 'How to use')}
            </h3>
            <p className={SECTION_LEAD_CLASS}>
              {t(
                'admin.integrations.actionDetail.howLead',
                'Extra help for using this action well, and where it is already in use.'
              )}
            </p>
            <EditableText
              testId="action-guidance"
              label={t('admin.integrations.actionDetail.guidance', 'Model guidance')}
              value={detail.action.guidance}
              overridden={detail.action.overridden.guidance}
              editValue={textInLanguage(detail.action.overrideTexts.guidance, lang)}
              placeholder={t('admin.integrations.actionDetail.noGuidance', 'No guidance.')}
              help={t(
                'admin.integrations.actionDetail.guidanceHelp',
                'Added to the system prompt while this integration is active in a chat. Saved for the current language.'
              )}
              busy={busy}
              onSave={text =>
                saveOverride({
                  guidance: withLanguageText(detail.action.overrideTexts.guidance, lang, text)
                })
              }
              onReset={() => saveOverride({ guidance: null })}
            />
            <div className="mt-4">
              <EditableText
                testId="action-examples"
                label={t('admin.integrations.actionDetail.examples', 'Example prompts')}
                value={detail.action.examples.join('\n')}
                overridden={detail.action.overridden.examples}
                editValue={(detail.action.overrideTexts.examples || [])
                  .map(example => textInLanguage(example, lang))
                  .filter(Boolean)
                  .join('\n')}
                placeholder={t('admin.integrations.actionDetail.noExamples', 'No example prompts.')}
                help={t(
                  'admin.integrations.actionDetail.examplesHelp',
                  'One prompt per line, shown to users as ideas for what to ask. Saved for the current language.'
                )}
                busy={busy}
                onSave={text =>
                  saveOverride({
                    examples: withLanguageExamples(detail.action.overrideTexts.examples, lang, text)
                  })
                }
                onReset={() => saveOverride({ examples: null })}
              />
            </div>
            {detail.instructions.text && (
              <div className="mt-4">
                <span className={`mb-1 block ${FIELD_LABEL_CLASS}`}>
                  {t(
                    'admin.integrations.actionDetail.integrationInstructions',
                    'Integration instructions'
                  )}
                  <span className="ml-2 text-xs font-normal text-gray-600 dark:text-gray-400">
                    {t('admin.integrations.actionDetail.from', 'from {{source}}', {
                      source: sourceLabel(
                        t,
                        detail.instructions.source === 'server'
                          ? 'protocol'
                          : detail.instructions.source
                      )
                    })}
                  </span>
                </span>
                <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
                  {detail.instructions.text}
                </p>
                <p className={HELP_CLASS}>
                  {t(
                    'admin.integrations.actionDetail.instructionsHint',
                    'Edited on the Overview of the installation; added to the system prompt with the guidance of each action.'
                  )}
                </p>
              </div>
            )}
            <div className="mt-4" data-testid="action-bindings">
              <span className={`mb-1 block ${FIELD_LABEL_CLASS}`}>
                {t('admin.integrations.actionDetail.usedBy', 'Used by')}
              </span>
              {detail.bindings.apps.length +
                detail.bindings.workflows.length +
                detail.bindings.scheduledTasks.length ===
              0 ? (
                <p className={HELP_CLASS}>
                  {t(
                    'admin.integrations.actionDetail.unused',
                    'No app, workflow or scheduled task binds this action.'
                  )}
                </p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {detail.bindings.apps.map(app => (
                    <li key={`app-${app.id}`}>
                      <span className="text-gray-600 dark:text-gray-400">
                        {t('admin.integrations.actionDetail.bindingApp', 'App')}:{' '}
                      </span>
                      <Link to={`/admin/apps/${encodeURIComponent(app.id)}`} className={LINK_CLASS}>
                        {app.name}
                      </Link>
                    </li>
                  ))}
                  {detail.bindings.workflows.map(workflow => (
                    <li key={`wf-${workflow.id}`}>
                      <span className="text-gray-600 dark:text-gray-400">
                        {t('admin.integrations.actionDetail.bindingWorkflow', 'Workflow')}:{' '}
                      </span>
                      <Link
                        to={`/admin/workflows/${encodeURIComponent(workflow.id)}/edit`}
                        className={LINK_CLASS}
                      >
                        {workflow.name}
                      </Link>
                    </li>
                  ))}
                  {detail.bindings.scheduledTasks.map(task => (
                    <li key={`task-${task.id}`}>
                      <span className="text-gray-600 dark:text-gray-400">
                        {t('admin.integrations.actionDetail.bindingTask', 'Scheduled task')}:{' '}
                      </span>
                      <Link to="/admin/scheduled-tasks" className={LINK_CLASS}>
                        {task.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className={SECTION_CLASS} aria-labelledby="action-test-title">
            <h3 id="action-test-title" className={SECTION_TITLE_CLASS}>
              {t('admin.integrations.actionDetail.test.title', 'Test')}
            </h3>
            <ActionTestPanel
              key={`${instanceId}:${actionName}`}
              instanceId={instanceId}
              detail={detail}
              userName={userName}
            />
          </section>

          <section className={SECTION_CLASS} aria-labelledby="action-usage-title">
            <h3 id="action-usage-title" className={SECTION_TITLE_CLASS}>
              {t('admin.integrations.actionDetail.usage', 'Usage in the last {{days}} days', {
                days: detail.usage?.days || 7
              })}
            </h3>
            <p className={SECTION_LEAD_CLASS}>
              {t(
                'admin.integrations.actionDetail.usageLead',
                'How often this action was used, and how often approvals were granted or refused.'
              )}
            </p>
            {detail.usage ? (
              <dl
                className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3"
                data-testid="action-usage"
              >
                {[
                  ['calls', t('admin.integrations.actionDetail.usageCalls', 'Calls')],
                  ['approved', t('admin.integrations.actionDetail.usageApproved', 'Approved')],
                  ['rejected', t('admin.integrations.actionDetail.usageRejected', 'Rejected')],
                  [
                    'expired',
                    t('admin.integrations.actionDetail.usageExpired', 'Approvals expired')
                  ],
                  ['errors', t('admin.integrations.actionDetail.usageErrors', 'Errors')],
                  ['tests', t('admin.integrations.actionDetail.usageTests', 'Admin tests')]
                ].map(([key, label]) => (
                  <div key={key} className="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
                    <dt className="text-xs text-gray-600 dark:text-gray-400">{label}</dt>
                    <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {detail.usage[key]}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className={HELP_CLASS}>
                {t(
                  'admin.integrations.actionDetail.usageUnavailable',
                  'The usage could not be read.'
                )}
              </p>
            )}
            <p className={`mt-2 ${HELP_CLASS}`}>
              {t(
                'admin.integrations.actionDetail.usageHelp',
                'Counted by this server since this version: calls from chats, workflows and scheduled runs, answers to approval requests, and admin tests (not counted as calls).'
              )}
            </p>
          </section>
        </div>
      )}
    </Drawer>
  );
}

export default IntegrationActionDrawer;
