// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import AdminLoadError from '../components/AdminLoadError';
import AdminTabs from '../components/AdminTabs';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import {
  CALLOUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../components/formStyles';
import BuilderBasicsStep from '../components/integrations/builder/BuilderBasicsStep';
import BuilderAuthStep from '../components/integrations/builder/BuilderAuthStep';
import BuilderSourceStep from '../components/integrations/builder/BuilderSourceStep';
import BuilderActionsStep from '../components/integrations/builder/BuilderActionsStep';
import BuilderReviewStep from '../components/integrations/builder/BuilderReviewStep';
import {
  BUILDER_STEPS,
  draftForSave,
  emptyDraft,
  firstIncompleteStep,
  stepErrors,
  stepOfServerPath,
  withSource
} from '../components/integrations/builder/builderModel';
import { getAdminApiErrorMessage } from '../../../api/adminApi';
import {
  createCustomIntegration,
  exportCustomIntegration,
  fetchBuilderDraft,
  saveCustomIntegration
} from '../../../api/integrationsAdminApi';

/** The label of a builder step. */
function stepLabel(t, step) {
  switch (step) {
    case 'basics':
      return t('admin.integrationBuilder.steps.basics', 'Basics');
    case 'signIn':
      return t('admin.integrationBuilder.steps.signIn', 'Sign-in');
    case 'source':
      return t('admin.integrationBuilder.steps.source', 'Source');
    case 'actions':
      return t('admin.integrationBuilder.steps.actions', 'Actions');
    default:
      return t('admin.integrationBuilder.steps.review', 'Review');
  }
}

/** Offer a JSON value as a file download. */
function downloadJson(fileName, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Admin → Integrations → **Add manually** (`/admin/integrations/builder/new`)
 * and **Edit in builder** (`/admin/integrations/builder/:instanceId`): the
 * integration builder. It replaces the Tools page: a custom integration gets
 * its actions from an OpenAPI document, an MCP server, an A2A agent, HTTP
 * request templates or a JavaScript module, and is saved as a definition
 * `custom/<id>` plus an installation `<id>`. Each action carries its
 * description, parameters, side effect, data flow and approval.
 *
 * Steps (tabs): Basics, Sign-in, Source, Actions, Review. Saving opens the
 * installation's page, where it is tested, bound to apps and granted to
 * groups like any other integration. A saved integration can be exported as
 * a registry package.
 */
function AdminIntegrationBuilderPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { instanceId } = useParams();
  const isNew = !instanceId || instanceId === 'new';

  const [draft, setDraft] = useState(() => (isNew ? emptyDraft() : null));
  const [initial, setInitial] = useState(() => (isNew ? emptyDraft() : null));
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState(null);
  const [step, setStep] = useState('basics');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [pendingSource, setPendingSource] = useState(null);
  const [exportMessage, setExportMessage] = useState(null);

  const { blocker, markSaved } = useUnsavedChanges(initial, draft);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await fetchBuilderDraft(instanceId);
      setDraft(loaded);
      setInitial(loaded);
    } catch (err) {
      setLoadError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    if (!isNew) void load();
  }, [isNew, load]);

  const errors = useMemo(() => (draft ? stepErrors(draft, step) : {}), [draft, step]);
  const visibleErrors = showErrors ? errors : {};
  const index = BUILDER_STEPS.indexOf(step);

  const patch = changes => setDraft(current => ({ ...current, ...changes }));

  const changeSource = source => {
    if (source === draft.source) return;
    if ((draft.actions || []).length > 0) setPendingSource(source);
    else setDraft(current => withSource(current, source));
  };

  const goTo = next => {
    setShowErrors(false);
    setStep(next);
  };

  const next = () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    goTo(BUILDER_STEPS[index + 1]);
  };

  const save = async () => {
    const incomplete = firstIncompleteStep(draft);
    if (incomplete) {
      setStep(incomplete);
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const payload = draftForSave(draft);
      const result = isNew
        ? await createCustomIntegration(payload)
        : await saveCustomIntegration(instanceId, payload);
      markSaved();
      navigate(`/admin/integrations/${encodeURIComponent(result.instance.id)}`, {
        state: {
          flash: {
            type: 'success',
            text: t('admin.integrationBuilder.saved', 'Integration "{{id}}" saved.', {
              id: result.instance.id
            })
          }
        }
      });
    } catch (err) {
      const details = err?.response?.data?.details?.issues;
      setSaveError({
        message: getAdminApiErrorMessage(err),
        details: Array.isArray(details) ? details : []
      });
      const first = Array.isArray(details) ? details[0] : null;
      if (first?.path) setStep(stepOfServerPath(first.path));
    } finally {
      setSaving(false);
    }
  };

  const exportPackage = async () => {
    setExportMessage(null);
    try {
      const pkg = await exportCustomIntegration(instanceId);
      downloadJson(`${pkg.catalogItem?.name || instanceId}.integration-package.json`, pkg);
      setExportMessage({
        type: 'success',
        text: t(
          'admin.integrationBuilder.exported',
          'Exported. Publish the files under integration-definitions/{{name}}/ and add the catalog item to your registry’s catalog.json.',
          { name: pkg.catalogItem?.name || '' }
        )
      });
    } catch (err) {
      setExportMessage({ type: 'error', text: getAdminApiErrorMessage(err) });
    }
  };

  const crumbs = [
    { label: t('admin.nav.integrations', 'Integrations'), href: '/admin/integrations' },
    ...(!isNew
      ? [{ label: instanceId, href: `/admin/integrations/${encodeURIComponent(instanceId)}` }]
      : []),
    {
      label: isNew
        ? t('admin.integrationBuilder.titleNew', 'Add manually')
        : t('admin.integrationBuilder.titleEdit', 'Edit in builder')
    }
  ];

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }
  if (loadError || !draft) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AdminBreadcrumb crumbs={crumbs} />
        <AdminLoadError
          framed={false}
          title={t('admin.integrationBuilder.loadError', 'Could not open the integration')}
          message={loadError || ''}
          action={{
            label: t('admin.integrations.backToIntegrations', 'Back to Integrations'),
            onClick: () => navigate('/admin/integrations')
          }}
        />
      </div>
    );
  }

  const tabs = BUILDER_STEPS.map(id => ({ id, label: stepLabel(t, id) }));

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <AdminBreadcrumb crumbs={crumbs} />
      <div className="flex flex-wrap justify-between items-start gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {isNew
              ? t('admin.integrationBuilder.titleNew', 'Add manually')
              : t('admin.integrationBuilder.titleEditOf', 'Edit {{id}} in the builder', {
                  id: instanceId
                })}
          </h1>
          <p className="mt-1 max-w-3xl text-gray-600 dark:text-gray-400">
            {t(
              'admin.integrationBuilder.subtitle',
              'Build an integration from an OpenAPI document, HTTP requests, a script, an MCP server or an A2A agent. It is installed under its ID and works like every other integration: bind it to apps, grant it to groups, test it on its page.'
            )}
          </p>
        </div>
        {!isNew && (
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={exportPackage}>
            <Icon name="download" size="sm" />
            {t('admin.integrationBuilder.export', 'Export for a registry')}
          </button>
        )}
      </div>

      {exportMessage && (
        <output
          className={`mb-4 block ${exportMessage.type === 'error' ? CALLOUT_CLASS.danger : CALLOUT_CLASS.success}`}
        >
          {exportMessage.text}
        </output>
      )}
      {saveError && (
        <div role="alert" className={`mb-4 ${CALLOUT_CLASS.danger}`}>
          <p>{saveError.message}</p>
          {saveError.details.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {saveError.details.slice(0, 10).map((detail, i) => (
                <li key={i}>
                  <code>{(detail.path || []).join('.')}</code>: {detail.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <AdminTabs
        tabs={tabs}
        activeId={step}
        onChange={goTo}
        ariaLabel={t('admin.integrationBuilder.stepsLabel', 'Builder steps')}
      />

      <div
        role="tabpanel"
        id={`tabpanel-${step}`}
        aria-labelledby={`tab-${step}`}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6"
      >
        {step === 'basics' && (
          <BuilderBasicsStep draft={draft} onChange={patch} isNew={isNew} errors={visibleErrors} />
        )}
        {step === 'signIn' && (
          <BuilderAuthStep draft={draft} onChange={patch} errors={visibleErrors} />
        )}
        {step === 'source' && (
          <BuilderSourceStep
            draft={draft}
            onChange={patch}
            onSourceChange={changeSource}
            errors={visibleErrors}
          />
        )}
        {step === 'actions' && (
          <BuilderActionsStep draft={draft} onChange={patch} errors={visibleErrors} />
        )}
        {step === 'review' && <BuilderReviewStep draft={draft} />}
      </div>

      <div className="mt-6 flex flex-wrap justify-between gap-3">
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          onClick={() => goTo(BUILDER_STEPS[index - 1])}
          disabled={index === 0}
        >
          <Icon name="chevron-left" size="sm" />
          {t('admin.integrationBuilder.back', 'Back')}
        </button>
        <div className="flex flex-wrap gap-3">
          {step !== 'review' && (
            <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={next}>
              {t('admin.integrationBuilder.next', 'Next')}
              <Icon name="chevron-right" size="sm" />
            </button>
          )}
          <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={save} disabled={saving}>
            {saving ? <LoadingSpinner size="sm" /> : <Icon name="check" size="sm" />}
            {isNew
              ? t('admin.integrationBuilder.create', 'Create integration')
              : t('admin.integrationBuilder.save', 'Save')}
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={Boolean(pendingSource)}
        title={t('admin.integrationBuilder.switchSource.title', 'Switch the source?')}
        message={t(
          'admin.integrationBuilder.switchSource.message',
          'The actions of the current source are removed.'
        )}
        confirmLabel={t('admin.integrationBuilder.switchSource.confirm', 'Switch')}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={() => {
          const source = pendingSource;
          setPendingSource(null);
          setDraft(current => withSource(current, source));
        }}
        onDeny={() => setPendingSource(null)}
      />
      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        title={t('admin.integrationBuilder.unsaved.title', 'Unsaved changes')}
        message={t(
          'admin.integrationBuilder.unsaved.message',
          'The integration is not saved. Leave anyway?'
        )}
        confirmLabel={t('admin.integrationBuilder.unsaved.leave', 'Leave')}
        denyLabel={t('admin.integrationBuilder.unsaved.stay', 'Stay')}
        danger={false}
        onConfirm={() => blocker.proceed?.()}
        onDeny={() => blocker.reset?.()}
      />
    </div>
  );
}

export default AdminIntegrationBuilderPage;
