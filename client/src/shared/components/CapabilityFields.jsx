// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import ResourcePicker from '../../features/workflows/editor/panels/forms/ResourcePicker';
import FormField from '../../features/workflows/editor/panels/forms/FormField';
import { fetchInstalledIntegrations } from '../../api/integrationsAdminApi';

/**
 * The platform tools a workflow node or an agent profile may name in
 * `systemTools` (they are plain tools, not integrations).
 */
export const SYSTEM_TOOL_IDS = [
  'write_artifact',
  'read_memory',
  'write_memory',
  'read_inbox',
  'write_inbox',
  'create_task',
  'list_tasks',
  'mark_task_done',
  'evidence',
  'evidence_collect',
  'evidence_validateQuotesFastPath',
  'evidence_composeReport',
  'read_url'
];

const TYPE_PREFIX = 'type:';

const fetchSystemToolItems = () => Promise.resolve(SYSTEM_TOOL_IDS.map(id => ({ id, name: id })));

/**
 * The picker items for the installed integrations: each enabled installation
 * by its id, and each integration type as a `type:<type>` entry that binds
 * every installation of the type.
 *
 * @param {Array<Object>} installed - `GET /api/admin/integrations/installed` items
 * @param {(key: string, fallback: string, options?: Object) => string} t
 * @returns {Array<{ id: string, name: string }>}
 */
export function integrationPickerItems(installed, t) {
  const usable = (Array.isArray(installed) ? installed : []).filter(
    item => item && item.id && item.enabled !== false && !item.definitionMissing
  );
  const types = [...new Set(usable.map(item => item.type).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
  return [
    ...usable.map(item => ({
      id: item.id,
      name: item.definitionName
        ? `${item.label || item.id} (${item.definitionName})`
        : item.label || item.id
    })),
    ...types.map(type => ({
      id: `${TYPE_PREFIX}${type}`,
      name: t('admin.workflows.capabilities.allOfType', 'All {{type}} installations', { type })
    }))
  ];
}

/**
 * Editing of the three things a workflow node (prompt, verifier, a planner's
 * task template) or an agent profile can use: bound installed integrations
 * (`integrations`: `{ <installation id | definition id | type:…>: { actions? } }`),
 * platform tools (`systemTools`) and web search (`webSearch`).
 *
 * Picking an integration writes `{ [id]: {} }` (every default action); an
 * existing binding keeps its `actions` when other entries change. The
 * component reports a patch with only the changed field; an emptied field is
 * `undefined` so the caller can drop it from the saved config.
 *
 * @param {Object} props
 * @param {{ integrations?: Object, systemTools?: string[], webSearch?: boolean }} props.value
 * @param {(patch: Object) => void} props.onChange - receives e.g. `{ systemTools: [...] }`
 * @param {boolean} [props.showWebSearch=true] - Whether to offer the web search switch (a verifier has none)
 */
function CapabilityFields({ value, onChange, showWebSearch = true }) {
  const { t } = useTranslation();
  const integrations =
    value?.integrations && typeof value.integrations === 'object' ? value.integrations : {};

  const fetchIntegrationItems = useCallback(async () => {
    const res = await fetchInstalledIntegrations();
    return integrationPickerItems(res?.items, t);
  }, [t]);

  const handleIntegrations = ids => {
    const next = {};
    for (const id of ids) next[id] = integrations[id] || {};
    onChange({ integrations: Object.keys(next).length ? next : undefined });
  };

  const handleSystemTools = ids => onChange({ systemTools: ids.length ? ids : undefined });

  return (
    <>
      <ResourcePicker
        label={t('admin.workflows.capabilities.integrations', 'Integrations')}
        fetchFn={fetchIntegrationItems}
        value={Object.keys(integrations)}
        onChange={handleIntegrations}
        multi
        placeholder={t(
          'admin.workflows.capabilities.integrationsPlaceholder',
          'Search installed integrations...'
        )}
      />
      <ResourcePicker
        label={t('admin.workflows.capabilities.systemTools', 'Platform tools')}
        fetchFn={fetchSystemToolItems}
        value={Array.isArray(value?.systemTools) ? value.systemTools : []}
        onChange={handleSystemTools}
        multi
        placeholder={t(
          'admin.workflows.capabilities.systemToolsPlaceholder',
          'Search platform tools...'
        )}
      />
      {showWebSearch && (
        <FormField
          label={t('admin.workflows.capabilities.webSearch', 'Web search')}
          type="checkbox"
          value={value?.webSearch === true}
          onChange={v => onChange({ webSearch: v ? true : undefined })}
        />
      )}
    </>
  );
}

export default CapabilityFields;
