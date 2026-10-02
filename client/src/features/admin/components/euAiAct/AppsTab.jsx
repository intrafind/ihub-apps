import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import {
  clearAppDisclosureOptOut,
  declareAppExemption,
  setAppDisclosureOptOut,
  withdrawAppExemption
} from '../../../../api/aiTransparencyAdminApi';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { EXEMPTION_TYPES } from '../../../../../../shared/aiTransparency.js';
import { DataTable, FilterSelect } from '../data-table';
import { filterApps } from '../../utils/euAiAct';
import { CompliancePill } from './ComplianceBadges';
import JustificationDialog from './JustificationDialog';
import RecordSummary from './RecordSummary';

const ACTION_BUTTON =
  'inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
const ACTION_LINK =
  'text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline focus:outline-hidden focus:ring-2 focus:ring-indigo-500 rounded-sm whitespace-nowrap';

/** English fallbacks of the Art. 50(2) exemption types. */
const EXEMPTION_LABEL_FALLBACKS = {
  standardEditing: 'Standard editing',
  b2bTechnical: 'B2B technical output'
};

/** English fallbacks of the sensitive categories (guidelines ¶40). */
const SENSITIVE_LABEL_FALLBACKS = {
  legal: 'Legal',
  finance: 'Finance',
  health: 'Health',
  complaints: 'Complaints',
  vulnerable: 'Vulnerable groups'
};

/**
 * Exemption-type picker with what each exemption requires. Rendered inside
 * the justification dialog; the parent owns the selected value.
 *
 * @param {Object} props
 * @param {string|null} props.value
 * @param {(type: string) => void} props.onChange
 */
function ExemptionTypeFieldset({ value, onChange }) {
  const { t } = useTranslation();
  const groupId = useId();
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
        {t('admin.euAiAct.apps.exemptionDialog.typeLegend', 'Type of exemption')}
        <span className="text-red-600 dark:text-red-400" aria-hidden="true">
          {' '}
          *
        </span>
      </legend>
      {EXEMPTION_TYPES.map(type => {
        const inputId = `${groupId}-${type}`;
        const descriptionId = `${inputId}-description`;
        return (
          <div
            key={type}
            className={`rounded-md border p-3 ${
              value === type
                ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-900/20'
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            <div className="flex items-start gap-3">
              <input
                id={inputId}
                type="radio"
                name={`${groupId}-type`}
                value={type}
                checked={value === type}
                onChange={() => onChange(type)}
                aria-describedby={descriptionId}
                className="mt-0.5 h-4 w-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
              />
              <div className="min-w-0">
                <label
                  htmlFor={inputId}
                  className="text-sm font-medium text-gray-900 dark:text-gray-100"
                >
                  {t(
                    `admin.euAiAct.apps.exemptionTypes.${type}`,
                    EXEMPTION_LABEL_FALLBACKS[type] || type
                  )}
                </label>
                <div
                  id={descriptionId}
                  className="mt-1 text-xs text-gray-600 dark:text-gray-300 space-y-1"
                >
                  {type === 'standardEditing' ? (
                    <p>
                      {t(
                        'admin.euAiAct.apps.exemptionDialog.standardEditingHelp',
                        'The app only assists with standard editing that does not substantially change the input or its meaning: grammar and spell checking, translation, format conversion. Summaries and rewrites that change style, structure or meaning do not qualify.'
                      )}
                    </p>
                  ) : (
                    <>
                      <p>
                        {t(
                          'admin.euAiAct.apps.exemptionDialog.b2bHelp',
                          'Only if all three conditions of the guidelines (¶87) hold:'
                        )}
                      </p>
                      <ol className="list-decimal pl-5 space-y-0.5">
                        <li>
                          {t(
                            'admin.euAiAct.apps.exemptionDialog.b2bCondition1',
                            'The output is strictly technical (engineering designs, technical instructions, internal documentation before it is finalised).'
                          )}
                        </li>
                        <li>
                          {t(
                            'admin.euAiAct.apps.exemptionDialog.b2bCondition2',
                            'Only a limited, pre-defined group of professionals inside your organisation sees it.'
                          )}
                        </li>
                        <li>
                          {t(
                            'admin.euAiAct.apps.exemptionDialog.b2bCondition3',
                            'It is not meant to leave the organisation, and safeguards such as isolation and access control are in place.'
                          )}
                        </li>
                      </ol>
                      <p>
                        {t(
                          'admin.euAiAct.apps.exemptionDialog.b2bNotQualifying',
                          'Emails, marketing texts, reports and customer answers do not qualify.'
                        )}
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * Apps tab of the EU AI Act page: per app, whether the Art. 50(1)
 * interaction disclosure is on, the documented opt-out, the declared
 * Art. 50(2) exemption, the sensitive category and the temperature-0 flag —
 * with the actions to record or withdraw opt-outs and exemptions.
 *
 * @param {Object} props
 * @param {Object} props.status - `GET /admin/ai-transparency/status` response.
 * @param {() => Promise<unknown>} props.reload - Re-fetches the status.
 */
function AppsTab({ status, reload }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [filter, setFilter] = useState('all');
  const [optOutTarget, setOptOutTarget] = useState(null);
  const [exemptionTarget, setExemptionTarget] = useState(null);
  const [exemptionType, setExemptionType] = useState(null);
  const [busy, setBusy] = useState(null); // `${appId}:${action}` while a DELETE runs
  const [message, setMessage] = useState(null);

  const apps = Array.isArray(status?.apps) ? status.apps : [];
  const rows = filterApps(apps, filter);
  const nameOf = app => getLocalizedContent(app.name, language) || app.id;
  const exemptionLabel = type =>
    t(`admin.euAiAct.apps.exemptionTypes.${type}`, EXEMPTION_LABEL_FALLBACKS[type] || type);

  const handleOptOut = async reason => {
    await setAppDisclosureOptOut(optOutTarget.id, reason);
    setMessage({
      type: 'success',
      text: t('admin.euAiAct.apps.optOutSaved', 'The AI disclosure is now off for {{name}}.', {
        name: nameOf(optOutTarget)
      })
    });
    await reload();
  };

  const handleExemption = async justification => {
    await declareAppExemption(exemptionTarget.id, exemptionType, justification);
    setMessage({
      type: 'success',
      text: t('admin.euAiAct.apps.exemptionSaved', 'Exemption declared for {{name}}.', {
        name: nameOf(exemptionTarget)
      })
    });
    await reload();
  };

  /**
   * Run one of the withdraw actions (DELETE) with a busy flag and a message.
   * @param {Object} app
   * @param {'optOut'|'exemption'} action
   */
  const handleWithdraw = async (app, action) => {
    setBusy(`${app.id}:${action}`);
    setMessage(null);
    try {
      if (action === 'optOut') {
        await clearAppDisclosureOptOut(app.id);
        setMessage({
          type: 'success',
          text: t(
            'admin.euAiAct.apps.optOutCleared',
            'The AI disclosure is on again for {{name}}.',
            {
              name: nameOf(app)
            }
          )
        });
      } else {
        await withdrawAppExemption(app.id);
        setMessage({
          type: 'success',
          text: t('admin.euAiAct.apps.exemptionWithdrawn', 'Exemption withdrawn for {{name}}.', {
            name: nameOf(app)
          })
        });
      }
      await reload();
    } catch (err) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const dash = srText => (
    <span className="text-gray-400 dark:text-gray-500">
      <span aria-hidden="true">—</span>
      {srText && <span className="sr-only">{srText}</span>}
    </span>
  );

  const columns = [
    {
      key: 'name',
      header: t('admin.euAiAct.apps.columns.app', 'App'),
      sortable: true,
      sortAccessor: a => nameOf(a),
      valign: 'top',
      render: a => (
        <div className="min-w-0 space-y-1">
          <div className="font-medium text-gray-900 dark:text-gray-100 break-words">
            {nameOf(a)}
          </div>
          <div className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{a.id}</div>
          {!a.enabled && (
            <CompliancePill tone="neutral">
              {t('admin.euAiAct.common.disabled', 'Disabled')}
            </CompliancePill>
          )}
          {a.foreignRecords && (
            <p className="text-xs text-amber-800 dark:text-amber-300 whitespace-normal">
              {t(
                'admin.euAiAct.apps.foreignRecords',
                'Has records from another installation. They are ignored here; record them again if they still apply.'
              )}
            </p>
          )}
        </div>
      )
    },
    {
      key: 'disclosure',
      header: t('admin.euAiAct.apps.columns.disclosure', 'AI disclosure'),
      sortable: true,
      valign: 'top',
      maxWidth: 'md',
      render: a => {
        if (a.disclosure === 'on') {
          return (
            <CompliancePill tone="success">
              {t('admin.euAiAct.apps.disclosureOn', 'On')}
            </CompliancePill>
          );
        }
        if (a.optOut) {
          return (
            <div className="space-y-1">
              <CompliancePill tone="warning">
                {t('admin.euAiAct.apps.disclosureOptedOut', 'Off (opt-out)')}
              </CompliancePill>
              <RecordSummary record={a.optOut} compact />
            </div>
          );
        }
        return (
          <CompliancePill tone="error">
            {t('admin.euAiAct.apps.disclosureOffGlobal', 'Off for all apps')}
          </CompliancePill>
        );
      }
    },
    {
      key: 'exemption',
      header: t('admin.euAiAct.apps.columns.exemption', 'Exemption (Art. 50(2))'),
      sortable: true,
      sortAccessor: a => a.exemption?.type || '',
      valign: 'top',
      maxWidth: 'md',
      render: a =>
        a.exemption ? (
          <div className="space-y-1">
            <CompliancePill tone="info">{exemptionLabel(a.exemption.type)}</CompliancePill>
            <RecordSummary record={a.exemption} compact />
          </div>
        ) : (
          dash(t('admin.euAiAct.apps.noExemption', 'No exemption'))
        )
    },
    {
      key: 'sensitive',
      header: t('admin.euAiAct.apps.columns.sensitive', 'Sensitive category'),
      sortable: true,
      hideBelow: 'lg',
      valign: 'top',
      render: a =>
        a.sensitive
          ? t(
              `admin.euAiAct.apps.sensitive.${a.sensitive}`,
              SENSITIVE_LABEL_FALLBACKS[a.sensitive] || a.sensitive
            )
          : dash(t('admin.euAiAct.apps.notSensitive', 'None'))
    },
    {
      key: 'temperature',
      header: t('admin.euAiAct.apps.columns.temperature', 'Temperature'),
      sortable: true,
      sortAccessor: a => (a.temperatureZero ? 1 : 0),
      hideBelow: 'md',
      valign: 'top',
      maxWidth: 'xs',
      render: a =>
        a.temperatureZero ? (
          <div className="space-y-1">
            <CompliancePill tone="error">
              {t('admin.euAiAct.apps.temperatureZero', 'Temperature 0')}
            </CompliancePill>
            <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-normal">
              {t(
                'admin.euAiAct.apps.temperatureZeroHint',
                'The watermarking model embeds no watermark at temperature 0.'
              )}
            </p>
          </div>
        ) : a.preferredTemperature !== null && a.preferredTemperature !== undefined ? (
          String(a.preferredTemperature)
        ) : (
          dash(t('admin.euAiAct.apps.temperatureDefault', 'Default'))
        )
    },
    {
      key: 'actions',
      header: t('admin.euAiAct.apps.columns.actions', 'Actions'),
      valign: 'top',
      maxWidth: 'sm',
      render: a => {
        const name = nameOf(a);
        return (
          <div className="flex flex-col items-start gap-1.5">
            {a.optOut ? (
              <button
                type="button"
                className={ACTION_BUTTON}
                onClick={() => handleWithdraw(a, 'optOut')}
                disabled={busy === `${a.id}:optOut`}
              >
                {t('admin.euAiAct.apps.clearOptOut', 'Switch disclosure back on')}
                <span className="sr-only">: {name}</span>
              </button>
            ) : (
              <button
                type="button"
                className={ACTION_BUTTON}
                onClick={() => {
                  setMessage(null);
                  setOptOutTarget(a);
                }}
              >
                {t('admin.euAiAct.apps.optOut', 'Switch off disclosure…')}
                <span className="sr-only">: {name}</span>
              </button>
            )}
            {a.exemption ? (
              <button
                type="button"
                className={ACTION_BUTTON}
                onClick={() => handleWithdraw(a, 'exemption')}
                disabled={busy === `${a.id}:exemption`}
              >
                {t('admin.euAiAct.apps.withdrawExemption', 'Withdraw exemption')}
                <span className="sr-only">: {name}</span>
              </button>
            ) : (
              <button
                type="button"
                className={ACTION_BUTTON}
                onClick={() => {
                  setMessage(null);
                  setExemptionType(null);
                  setExemptionTarget(a);
                }}
              >
                {t('admin.euAiAct.apps.declareExemption', 'Declare exemption…')}
                <span className="sr-only">: {name}</span>
              </button>
            )}
            <Link to={`/admin/apps/${encodeURIComponent(a.id)}`} className={ACTION_LINK}>
              {t('admin.euAiAct.apps.edit', 'Edit app')}
              <span className="sr-only">: {name}</span>
            </Link>
          </div>
        );
      }
    }
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.euAiAct.apps.title', 'Apps: disclosure, opt-outs and exemptions')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.euAiAct.apps.description',
            'The Art. 50(1) disclosure tells users they are interacting with an AI. It is on for every app unless you document an opt-out. Art. 50(2) exemptions are declared per app with a justification. Every record is stored with who, when and the installation, and appears in the compliance report.'
          )}
        </p>
      </div>

      <div aria-live="polite" role="status">
        {message && (
          <p
            className={`rounded-md border px-4 py-3 text-sm ${
              message.type === 'success'
                ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300'
            }`}
          >
            {message.text}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label={t('admin.euAiAct.apps.filter.label', 'Show')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('admin.euAiAct.apps.filter.all', 'All apps') },
            {
              value: 'records',
              label: t('admin.euAiAct.apps.filter.records', 'With opt-out or exemption')
            },
            { value: 'issues', label: t('admin.euAiAct.apps.filter.issues', 'With issues') }
          ]}
        />
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {t('admin.euAiAct.apps.count', 'Apps shown: {{shown}} of {{total}}', {
            shown: rows.length,
            total: apps.length
          })}
        </span>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={a => a.id}
        stickyHeader={false}
        empty={{
          icon: 'list',
          title: t('admin.euAiAct.apps.empty', 'No apps match this filter.')
        }}
      />

      <JustificationDialog
        open={Boolean(optOutTarget)}
        title={t(
          'admin.euAiAct.apps.optOutDialog.title',
          'Switch off the AI disclosure for {{name}}',
          {
            name: optOutTarget ? nameOf(optOutTarget) : ''
          }
        )}
        description={
          <>
            <p>
              {t(
                'admin.euAiAct.apps.optOutDialog.description',
                'Art. 50(1) requires telling people that they are interacting with an AI unless this is obvious from the context — for example an internal assistant used by trained, AI-literate staff (guidelines ¶45). Customer-facing or public apps do not qualify.'
              )}
            </p>
            <p>
              {t(
                'admin.euAiAct.apps.optOutDialog.record',
                'Explain why the interaction is obvious for the users of this app. The reason appears on this page and in the compliance report.'
              )}
            </p>
          </>
        }
        label={t('admin.euAiAct.dialog.reason', 'Reason')}
        submitLabel={t('admin.euAiAct.apps.optOutDialog.submit', 'Switch off disclosure')}
        onSubmit={handleOptOut}
        onClose={() => setOptOutTarget(null)}
      />

      <JustificationDialog
        open={Boolean(exemptionTarget)}
        title={t('admin.euAiAct.apps.exemptionDialog.title', 'Declare an exemption for {{name}}', {
          name: exemptionTarget ? nameOf(exemptionTarget) : ''
        })}
        description={
          <p>
            {t(
              'admin.euAiAct.apps.exemptionDialog.description',
              'With an Art. 50(2) exemption, text generated in this app does not have to be marked. Declare it only if the conditions below hold, and explain why. The declaration appears on this page and in the compliance report.'
            )}
          </p>
        }
        label={t('admin.euAiAct.dialog.justification', 'Justification')}
        submitLabel={t('admin.euAiAct.apps.exemptionDialog.submit', 'Declare exemption')}
        canSubmit={Boolean(exemptionType)}
        onSubmit={handleExemption}
        onClose={() => {
          setExemptionTarget(null);
          setExemptionType(null);
        }}
      >
        <ExemptionTypeFieldset value={exemptionType} onChange={setExemptionType} />
      </JustificationDialog>
    </div>
  );
}

export default AppsTab;
