// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import AdminLoadError from '../components/AdminLoadError';
import useAdminPageAccess from '../hooks/useAdminPageAccess';
import AccessStep from '../components/provider-connect/AccessStep';
import ConnectionStep from '../components/provider-connect/ConnectionStep';
import ConnectStepper from '../components/provider-connect/ConnectStepper';
import DefaultStep from '../components/provider-connect/DefaultStep';
import DoneStep from '../components/provider-connect/DoneStep';
import ModelsStep from '../components/provider-connect/ModelsStep';
import TestStep from '../components/provider-connect/TestStep';
import VendorStep from '../components/provider-connect/VendorStep';
import useProviderConnect from '../components/provider-connect/useProviderConnect';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../components/provider-connect/connectStyles';

/**
 * "Connect a model provider" (W1): a guided flow from "where are your models?"
 * to a provider, its linked models, an explicit default model and the groups
 * that may use them. Reached from the models setup strip, the empty Models
 * list, "Add provider" on the Providers tab, Cmd+K and the first-run setup.
 * `?vendor=<tile id>` starts at the connection of that tile.
 *
 * The page only renders; state and API calls are in useProviderConnect and
 * the step rules in utils/providerConnect.js.
 */
function AdminProviderConnectPage() {
  const { t, i18n } = useTranslation();
  const access = useAdminPageAccess();
  const [searchParams] = useSearchParams();
  const flow = useProviderConnect({ initialTileId: searchParams.get('vendor') });
  const { step, tile, form, target } = flow;

  if (flow.loadError) {
    return (
      <AdminLoadError
        title={t('admin.providers.connect.loadError', 'Could not load providers and models')}
        message={flow.loadError}
      />
    );
  }

  const providerName =
    target.mode === 'existing'
      ? getLocalizedContent(target.provider.name, i18n.language) || target.provider.id
      : form?.name || '';

  const nextLabel = (() => {
    if (flow.running) return t('admin.providers.connect.saving', 'Saving…');
    if (step === 'access') {
      return t('admin.providers.connect.finish', 'Connect and add {{count}} models', {
        count: flow.picks.length
      });
    }
    if (step === 'connection' && tile?.discovery === false) {
      return t('admin.providers.connect.saveKey', 'Save the key');
    }
    if (step === 'connection') return t('admin.providers.connect.testAction', 'Test connection');
    return t('admin.providers.connect.next', 'Next');
  })();

  // Default model: a picked chat model when one was chosen, else the first
  // created chat model, so the smoke test has something to send to.
  const smokeModelId = (() => {
    if (!flow.outcome) return null;
    const created = new Set(flow.outcome.models.filter(m => m.ok).map(m => m.id));
    if (flow.outcome.defaultId && created.has(flow.outcome.defaultId)) {
      return flow.outcome.defaultId;
    }
    return flow.candidates.find(c => created.has(c.id))?.id || null;
  })();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AdminBreadcrumb
          crumbs={[
            { label: t('documentTitle.admin', 'Admin'), href: '/admin' },
            ...(access.models
              ? [{ label: t('admin.nav.models', 'Models'), href: '/admin/models' }]
              : []),
            { label: t('admin.nav.providers', 'Providers'), href: '/admin/providers' },
            { label: t('admin.providers.connect.title', 'Connect a model provider') }
          ]}
        />
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          {t('admin.providers.connect.title', 'Connect a model provider')}
        </h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.providers.connect.subtitle',
            'Connect a service, test it, pick its models and choose who can use them — in one go.'
          )}
        </p>

        <div className="mt-6">
          <ConnectStepper steps={flow.steps} current={step} />
        </div>

        <div className="mt-6 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xs">
          {flow.loading ? (
            <div
              role="status"
              className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400"
            >
              <Icon name="refresh" className="h-4 w-4 animate-spin" />
              {t('common.loading', 'Loading...')}
            </div>
          ) : (
            <>
              {step === 'vendor' && (
                <VendorStep
                  tiles={flow.tiles}
                  providers={flow.providers}
                  selectedId={tile?.id || null}
                  onSelect={flow.chooseTile}
                />
              )}
              {step === 'connection' && tile && form && (
                <ConnectionStep
                  tile={tile}
                  form={form}
                  target={target}
                  providers={flow.providers}
                  onChange={flow.updateForm}
                />
              )}
              {step === 'test' && (
                <TestStep
                  testing={flow.testing}
                  discovery={flow.discovery}
                  error={flow.testError}
                  url={form?.url || ''}
                  onRetry={flow.runTest}
                  onEditConnection={() => flow.setStep('connection')}
                />
              )}
              {step === 'models' && (
                <ModelsStep
                  total={flow.models.length}
                  selectedCount={flow.picks.length}
                  search={flow.search}
                  onSearch={flow.setSearch}
                  prefix={flow.prefix}
                  onPrefix={flow.setPrefix}
                  hasAzureDeployments={flow.isAzure}
                  listProps={{
                    models: flow.visibleModels,
                    selected: flow.selected,
                    onToggle: (modelId, checked) =>
                      flow.setSelected(prev => ({ ...prev, [modelId]: checked })),
                    allSelected: flow.allSelected,
                    onToggleAll: flow.toggleAll,
                    targetIdOf: flow.targetIdOf,
                    onIdChange: (modelId, id) =>
                      flow.setEditedIds(prev => ({ ...prev, [modelId]: id })),
                    idProblems: flow.idProblems,
                    problemText: problem =>
                      ({
                        invalid: t(
                          'admin.models.import.errors.idInvalid',
                          'Use lowercase letters, numbers, dots, hyphens and underscores only.'
                        ),
                        exists: t(
                          'admin.models.import.errors.idExists',
                          'A model with this ID already exists.'
                        ),
                        duplicate: t(
                          'admin.models.import.errors.idDuplicate',
                          'Two selected models would get this ID.'
                        )
                      })[problem],
                    isAzure: flow.isAzure,
                    deployments: flow.deployments,
                    deploymentOf: flow.deploymentOf,
                    onDeploymentChange: (modelId, name) =>
                      flow.setDeployments(prev => ({ ...prev, [modelId]: name }))
                  }}
                />
              )}
              {step === 'default' && (
                <DefaultStep
                  candidates={flow.candidates}
                  currentDefault={flow.currentDefault}
                  choice={flow.defaultChoice}
                  onChoose={flow.setDefaultChoice}
                />
              )}
              {step === 'access' && (
                <AccessStep
                  groupsFile={flow.groupsFile}
                  wildcardGroups={flow.wildcardGroups}
                  access={flow.access}
                  onChange={flow.setAccess}
                />
              )}
              {step === 'done' && flow.outcome && (
                <DoneStep
                  providerId={flow.providerId}
                  providerName={providerName}
                  outcome={flow.outcome}
                  smokeModelId={smokeModelId}
                  defaultId={flow.outcome.defaultId}
                  noListing={tile?.discovery === false}
                />
              )}
            </>
          )}
        </div>

        {!flow.loading && step !== 'done' && (
          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={flow.goBack}
              disabled={step === 'vendor' || flow.running}
            >
              {t('admin.providers.connect.back', 'Back')}
            </button>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={flow.goNext}
              disabled={!flow.canAdvance || flow.running || flow.testing}
              data-testid="connect-next"
            >
              {nextLabel}
            </button>
          </div>
        )}
        {step === 'done' && flow.outcome?.providerError && (
          <div className="mt-4">
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => flow.setStep('connection')}
            >
              {t('admin.providers.connect.backToConnection', 'Back to the connection')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default AdminProviderConnectPage;
