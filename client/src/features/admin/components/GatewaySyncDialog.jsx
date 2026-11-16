// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import { translateDiscoveryError } from '../utils/modelImport';
import { applyGatewaySync, countByKind, formatChangeValue, itemKey } from '../utils/gatewaySync';

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50';
const BADGE = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium';

/** The kinds of drift, in the order they are shown. */
const KINDS = ['changed', 'added', 'removed'];

/**
 * "Sync models": compare the models a provider lists now (an iFinder Model Gateway or
 * Google) with the models imported from it, and apply the ones the admin picks.
 *
 * The comparison (`GET /admin/providers/:id/_model-drift`) changes nothing. The
 * admin sees what is new at the provider, what changed, and what is gone. Changes and gone
 * models start ticked so a plain "Apply" brings the models in line; new models start
 * unticked, because importing one makes it available. A gone model is disabled,
 * never deleted. The server applies the pick and answers one outcome per item, so
 * a failure of one does not hide the others.
 *
 * Mount it only while it is open: its state is not reset between openings.
 *
 * @param {Object} props
 * @param {string} props.providerId - The provider (a model gateway or Google)
 * @param {() => void} props.onClose
 * @param {() => void} [props.onSynced] - Called once after changes were applied, so the page reloads its models
 */
function GatewaySyncDialog({ providerId, onClose, onSynced }) {
  const { t } = useTranslation();

  // 'loading' | 'review' | 'applying' | 'done' | 'error'
  const [step, setStep] = useState('loading');
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState({});
  const [results, setResults] = useState([]);

  const load = useCallback(async () => {
    setStep('loading');
    setError(null);
    try {
      const response = await makeAdminApiCall(
        `/admin/providers/${encodeURIComponent(providerId)}/_model-drift`
      );
      const list = Array.isArray(response.data?.items) ? response.data.items : [];
      setItems(list);
      // Changes and gone models start ticked: they bring the imported models in line. New models
      // start unticked: an admin who left a model out on purpose must not make it available to
      // users by clicking Apply on the rest.
      setSelected(Object.fromEntries(list.map(item => [itemKey(item), item.kind !== 'added'])));
      setStep('review');
    } catch (err) {
      // Kept as the server sent it and translated when shown: `load` must not
      // depend on `t`, or every language change would ask the gateway again.
      const body = err?.response?.data || {};
      setError({
        reason: body.details?.reason,
        message: body.detail || getAdminApiErrorMessage(err),
        hint: body.details?.hint
      });
      setStep('error');
    }
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const picked = useMemo(() => items.filter(item => selected[itemKey(item)]), [items, selected]);
  const counts = useMemo(() => countByKind(items), [items]);

  const apply = async () => {
    if (picked.length === 0) return;
    setStep('applying');
    const outcome = await applyGatewaySync(providerId, picked);
    setResults(outcome);
    setStep('done');
    // The models changed whichever way it went: let the page reload them.
    if (outcome.some(result => result.ok)) onSynced?.();
  };

  const toggle = key => setSelected(prev => ({ ...prev, [key]: !prev[key] }));

  const sectionTitle = kind =>
    ({
      changed: t('admin.providers.sync.changed', 'Changed at the provider'),
      added: t('admin.providers.sync.added', 'New at the provider'),
      removed: t('admin.providers.sync.removed', 'No longer available')
    })[kind];

  const sectionHint = kind =>
    ({
      changed: t('admin.providers.sync.changedHint', 'The model is updated to match the provider.'),
      added: t('admin.providers.sync.addedHint', 'The model is imported.'),
      removed: t(
        'admin.providers.sync.removedHint',
        'The model is disabled, not deleted: apps may still use it.'
      )
    })[kind];

  const fieldLabel = field =>
    ({
      url: t('admin.providers.sync.fields.url', 'URL'),
      provider: t('admin.providers.sync.fields.provider', 'Adapter'),
      contextWindow: t('admin.providers.sync.fields.contextWindow', 'Context window'),
      supportsVision: t('admin.providers.sync.fields.supportsVision', 'Image input'),
      contentMarking: t('admin.providers.sync.fields.contentMarking', 'EU AI Act marking')
    })[field] || field;

  const reasonText = reason =>
    reason === 'unsupported'
      ? t(
          'admin.providers.sync.reasonUnsupported',
          'The provider now lists this model as something iHub cannot run.'
        )
      : t('admin.providers.sync.reasonMissing', 'The provider no longer lists this model.');

  const yesNo = {
    yes: t('common.yes', 'Yes'),
    no: t('common.no', 'No'),
    text: t('admin.providers.sync.markingText', 'Text'),
    image: t('admin.providers.sync.markingImage', 'Image')
  };

  const renderItem = item => {
    const key = itemKey(item);
    const id = `gateway-sync-${key}`;
    return (
      <li key={key} className="flex items-start gap-3 py-3">
        <input
          id={id}
          type="checkbox"
          checked={Boolean(selected[key])}
          onChange={() => toggle(key)}
          className="mt-1 h-4 w-4 rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500"
        />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
            {item.kind === 'added' ? item.name : item.modelId}
          </span>
          <span className="block break-all text-xs text-gray-500 dark:text-gray-400">
            {item.kind === 'added'
              ? t('admin.providers.sync.importedAs', '{{remoteId}} → imported as {{id}}', {
                  remoteId: item.remoteId,
                  id: item.model.id
                })
              : item.remoteId}
          </span>
          {item.kind === 'added' && (
            <span className="mt-1 flex flex-wrap gap-1">
              {item.model.modelType === 'transcription' && (
                <span
                  className={`${BADGE} bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300`}
                >
                  {t('admin.models.import.types.transcription', 'Transcription')}
                </span>
              )}
              {item.model.supportsVision && (
                <span
                  className={`${BADGE} bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300`}
                >
                  {t('admin.models.import.vision', 'Vision')}
                </span>
              )}
            </span>
          )}
          {item.kind === 'changed' && (
            <span className="mt-1 block space-y-0.5 text-xs text-gray-700 dark:text-gray-300">
              {item.changes.map(change => (
                <span key={change.field} className="block break-all">
                  <span className="font-medium">{fieldLabel(change.field)}:</span>{' '}
                  {formatChangeValue(change.field, change.from, yesNo)} →{' '}
                  {formatChangeValue(change.field, change.to, yesNo)}
                </span>
              ))}
            </span>
          )}
          {item.kind === 'removed' && (
            <span className="mt-1 block text-xs text-gray-700 dark:text-gray-300">
              {reasonText(item.reason)}
            </span>
          )}
        </label>
      </li>
    );
  };

  const renderReview = () => {
    if (items.length === 0) {
      return (
        <p role="status" className="text-sm text-gray-700 dark:text-gray-300">
          {t('admin.providers.sync.inSync', 'The models are in sync with the provider.')}
        </p>
      );
    }
    return (
      <div className="space-y-6">
        {KINDS.filter(kind => counts[kind] > 0).map(kind => (
          <section key={kind} aria-labelledby={`gateway-sync-${kind}`}>
            <h3
              id={`gateway-sync-${kind}`}
              className="text-sm font-semibold text-gray-900 dark:text-gray-100"
            >
              {sectionTitle(kind)} ({counts[kind]})
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">{sectionHint(kind)}</p>
            <ul className="mt-1 divide-y divide-gray-100 dark:divide-gray-700">
              {items.filter(item => item.kind === kind).map(renderItem)}
            </ul>
          </section>
        ))}
      </div>
    );
  };

  const renderDone = () => {
    const notApplied = results.filter(result => !result.ok);
    const detailText = result =>
      result.status === 'skipped'
        ? t(
            'admin.providers.sync.skipped',
            'The provider changed since you looked. Run the sync again.'
          )
        : result.detail;
    return (
      <div role="status" className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
        <p>
          {t('admin.providers.sync.doneSummary', '{{ok}} applied, {{failed}} not applied.', {
            ok: results.length - notApplied.length,
            failed: notApplied.length
          })}
        </p>
        {notApplied.length > 0 && (
          <ul className="space-y-1 text-red-700 dark:text-red-400">
            {notApplied.map(result => (
              <li key={result.key} className="break-all">
                {result.key.slice(result.key.indexOf(':') + 1)}: {detailText(result)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const renderError = () => (
    <div role="alert" className="text-sm text-red-700 dark:text-red-400">
      <p className="font-medium">{translateDiscoveryError(t, error?.reason, error?.message)}</p>
      {error?.hint && <p className="mt-1 text-xs break-words">{error.hint}</p>}
    </div>
  );

  return (
    <Modal isOpen onClose={onClose} maxWidthClassName="max-w-2xl" closeOnBackdropClick={false}>
      <div className="flex items-start justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.providers.sync.title', 'Sync models')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.providers.sync.subtitle',
              'Compare the provider’s models with the models imported from it. Nothing changes until you apply your choice.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="ml-4 p-1 rounded-md text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <Icon name="x" className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {(step === 'loading' || step === 'applying') && (
          <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
            {step === 'loading'
              ? t('admin.providers.sync.loading', 'Asking the provider…')
              : t('admin.providers.sync.applying', 'Applying…')}
          </p>
        )}
        {step === 'review' && renderReview()}
        {step === 'done' && renderDone()}
        {step === 'error' && renderError()}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-gray-200 dark:border-gray-700 px-6 py-3">
        {step === 'done' || (step === 'review' && items.length === 0) ? (
          <button type="button" className={PRIMARY_BUTTON} onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
        ) : (
          <>
            <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
              {t('common.cancel', 'Cancel')}
            </button>
            {step === 'error' ? (
              <button type="button" className={PRIMARY_BUTTON} onClick={load}>
                {t('admin.providers.sync.retry', 'Try again')}
              </button>
            ) : (
              <button
                type="button"
                className={PRIMARY_BUTTON}
                disabled={step !== 'review' || picked.length === 0}
                onClick={apply}
              >
                {t('admin.providers.sync.apply', 'Apply {{count}}', { count: picked.length })}
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export default GatewaySyncDialog;
