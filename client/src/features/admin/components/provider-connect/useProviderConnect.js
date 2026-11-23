// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../../api/adminApi';
import { findIdProblems, suggestModelId, translateDiscoveryError } from '../../utils/modelImport';
import {
  KEEP_DEFAULT,
  buildDiscoveryRequest,
  buildModelConfigs,
  buildProviderWrite,
  canTestConnection,
  classifyConnectionError,
  defaultCandidates,
  findCurrentDefault,
  findTile,
  getAvailableTiles,
  initialConnectionForm,
  isDefaultChoiceValid,
  nextStep,
  planGroupUpdates,
  previousStep,
  resolveTarget,
  runConnectPlan,
  stepsForTile,
  suggestedIdPrefix,
  updateConnectionForm,
  wildcardModelGroups
} from '../../utils/providerConnect';

/**
 * State and actions of "Connect a model provider". The rules live in
 * utils/providerConnect.js; this hook loads what they need (providers,
 * models, groups), keeps the answers of each step and runs the API calls.
 *
 * @param {Object} options
 * @param {string|null} [options.initialTileId] - Tile from `?vendor=`; the flow then starts at the connection
 * @returns {Object} State and actions for AdminProviderConnectPage
 */
export default function useProviderConnect({ initialTileId = null } = {}) {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [providers, setProviders] = useState([]);
  const [existingModels, setExistingModels] = useState([]);
  const [groupsFile, setGroupsFile] = useState(null);

  const [step, setStep] = useState('vendor');
  const [tileId, setTileId] = useState(null);
  const [form, setForm] = useState(null);

  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState(null);
  const [discovery, setDiscovery] = useState(null);

  const [selected, setSelected] = useState({});
  const [editedIds, setEditedIds] = useState({});
  const [deployments, setDeployments] = useState({});
  const [prefix, setPrefix] = useState('');
  const [search, setSearch] = useState('');

  const [defaultChoice, setDefaultChoice] = useState(null);
  const [access, setAccess] = useState({ mode: 'everyone', groupIds: [] });

  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState(null);

  const tile = tileId ? findTile(tileId) : null;
  const target = useMemo(
    () => (tile ? resolveTarget(tile, providers) : { mode: 'new' }),
    [tile, providers]
  );

  const chooseTile = useCallback(
    (id, list = providers) => {
      const chosen = findTile(id);
      if (!chosen) return;
      setTileId(id);
      setForm(initialConnectionForm(chosen, resolveTarget(chosen, list).provider));
      setDiscovery(null);
      setTestError(null);
    },
    [providers]
  );

  // Providers and models are needed to decide anything; groups only for step
  // 6, which says so when they cannot be read.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [providerResponse, modelResponse] = await Promise.all([
          makeAdminApiCall('/admin/providers'),
          makeAdminApiCall('/admin/models')
        ]);
        if (cancelled) return;
        const providerList = providerResponse.data?.items || [];
        setProviders(providerList);
        setExistingModels(modelResponse.data?.items || []);
        try {
          const groupResponse = await makeAdminApiCall('/admin/groups');
          if (!cancelled) setGroupsFile(groupResponse.data || null);
        } catch {
          if (!cancelled) setGroupsFile(null);
        }
        const initial = initialTileId ? findTile(initialTileId) : null;
        if (initial && getAvailableTiles(providerList).includes(initial)) {
          chooseTile(initial.id, providerList);
          setStep('connection');
        }
      } catch (err) {
        if (!cancelled) setLoadError(getAdminApiErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Loaded once per mount; chooseTile is called with the fresh list.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [initialTileId]);

  const tiles = useMemo(() => getAvailableTiles(providers), [providers]);

  /** A changed connection invalidates the last test and what was picked from it. */
  const updateForm = useCallback((field, value) => {
    setForm(prev => updateConnectionForm(prev, field, value));
    setDiscovery(null);
    setTestError(null);
  }, []);

  const runTest = useCallback(async () => {
    if (!tile || !form) return;
    setTesting(true);
    setTestError(null);
    setDiscovery(null);
    try {
      const response = await makeAdminApiCall('/admin/models/_discover', {
        method: 'POST',
        body: buildDiscoveryRequest(tile, form, target)
      });
      setDiscovery(response.data);
      setSelected({});
      setEditedIds({});
      setDeployments({});
      setSearch('');
      setPrefix(suggestedIdPrefix(target, form));
      setDefaultChoice(null);
    } catch (err) {
      const body = err?.response?.data || {};
      const remediation = body.details?.remediation;
      setTestError({
        message: translateDiscoveryError(
          t,
          body.details?.messageKey,
          body.detail || getAdminApiErrorMessage(err)
        ),
        remediation,
        category: classifyConnectionError(
          body.details?.messageKey,
          remediation || body.detail,
          body.details?.upstreamStatus
        )
      });
    } finally {
      setTesting(false);
    }
  }, [tile, form, target, t]);

  // Entering the test step runs the test unless the connection already passed
  // it unchanged; "Test again" reruns it.
  useEffect(() => {
    if (step === 'test' && !discovery && !testing) void runTest();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [step]);

  const models = useMemo(() => discovery?.models || [], [discovery]);
  const isAzure = Boolean(discovery?.azure);
  const targetIdOf = useCallback(
    model => editedIds[model.id] ?? suggestModelId(model.id, prefix),
    [editedIds, prefix]
  );
  const deploymentOf = useCallback(
    model => (deployments[model.id] ?? model.id).trim(),
    [deployments]
  );

  const visibleModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(m =>
      [m.id, m.name, m.ownedBy].some(v => v && v.toLowerCase().includes(q))
    );
  }, [models, search]);

  const picks = useMemo(
    () =>
      models
        .filter(m => selected[m.id] && !m.unsupported)
        .map(model => ({ model, id: targetIdOf(model), deployment: deploymentOf(model) })),
    [models, selected, targetIdOf, deploymentOf]
  );
  const idProblems = findIdProblems(
    picks.map(p => ({ key: p.model.id, id: p.id })),
    existingModels.map(m => m.id)
  );
  const missingDeployment = isAzure && picks.some(p => !p.deployment);

  const selectableByDefault = visibleModels.filter(m => m.type === 'chat' && !m.existingModelId);
  const allSelected =
    selectableByDefault.length > 0 && selectableByDefault.every(m => selected[m.id]);
  const toggleAll = () =>
    setSelected(prev => {
      const next = { ...prev };
      for (const m of selectableByDefault) next[m.id] = !allSelected;
      return next;
    });

  const candidates = defaultCandidates(picks);
  const currentDefault = findCurrentDefault(existingModels);
  const wildcardGroups = useMemo(() => wildcardModelGroups(groupsFile), [groupsFile]);

  const canAdvance = (() => {
    switch (step) {
      case 'vendor':
        return Boolean(tile);
      case 'connection':
        return Boolean(tile && form && canTestConnection(tile, form, target, providers));
      case 'test':
        return Boolean(discovery && models.length > 0);
      case 'models':
        return picks.length > 0 && Object.keys(idProblems).length === 0 && !missingDeployment;
      case 'default':
        return isDefaultChoiceValid(defaultChoice, candidates, currentDefault);
      case 'access':
        return access.mode === 'everyone' || !groupsFile || access.groupIds.length > 0;
      default:
        return false;
    }
  })();

  const providerId = target.mode === 'existing' ? target.provider.id : form?.id;

  /**
   * Save everything: provider (or its key), the models, the group grants.
   * For a tile without a listing (Bedrock) only the provider is written.
   */
  const finish = async () => {
    setRunning(true);
    const noListing = tile.discovery === false;
    const defaultId = defaultChoice && defaultChoice !== KEEP_DEFAULT ? defaultChoice : null;
    const modelConfigs = noListing
      ? []
      : buildModelConfigs({ discovery, picks, providerId, defaultId });
    const groupUpdates =
      noListing || !groupsFile
        ? []
        : planGroupUpdates(
            groupsFile,
            access,
            modelConfigs.map(c => c.id)
          );
    const result = await runConnectPlan({
      api: makeAdminApiCall,
      errorMessage: getAdminApiErrorMessage,
      providerWrite: buildProviderWrite(tile, form, target, discovery),
      modelConfigs,
      groupUpdates
    });
    setOutcome({ ...result, defaultId });
    setRunning(false);
    setStep('done');
  };

  const goNext = () => {
    if (!canAdvance || !tile) return;
    // The last step before "done" saves; Bedrock saves straight from the connection.
    const upcoming = nextStep(tile, step);
    if (upcoming === 'done') {
      void finish();
      return;
    }
    setStep(upcoming);
  };

  const goBack = () => {
    if (step === 'vendor' || step === 'done') return;
    setStep(prev => previousStep(tile, prev));
  };

  return {
    loading,
    loadError,
    providers,
    tiles,
    tile,
    target,
    form,
    step,
    steps: stepsForTile(tile),
    setStep,
    chooseTile,
    updateForm,
    testing,
    testError,
    discovery,
    runTest,
    models,
    visibleModels,
    isAzure,
    selected,
    setSelected,
    editedIds,
    setEditedIds,
    deployments,
    setDeployments,
    targetIdOf,
    deploymentOf,
    prefix,
    setPrefix,
    search,
    setSearch,
    picks,
    idProblems,
    allSelected,
    toggleAll,
    candidates,
    currentDefault,
    defaultChoice,
    setDefaultChoice,
    groupsFile,
    wildcardGroups,
    access,
    setAccess,
    canAdvance,
    goNext,
    goBack,
    running,
    outcome,
    providerId
  };
}
