import { useState, useEffect, useCallback } from 'react';
import { makeAdminApiCall } from '../../../api/adminApi';

/**
 * Shared load/toggle/bulk-toggle/delete/download/upload logic for admin
 * resource list pages (Apps, Models, Prompts, ...). Each resource's
 * page-specific extras (category pills, test-model action, tabs, etc.)
 * stay in the page component and compose with the state/handlers returned
 * here.
 *
 * @param {object} options
 * @param {() => Promise<any[]>} options.fetchFn - loads the resource list
 * @param {(ids: string|string[], enabled: boolean) => Promise<any>} options.toggleAllFn
 *   - bulk enable/disable call (e.g. toggleApps/toggleModels/togglePrompts)
 * @param {string} options.resourcePath - admin API path segment, e.g. 'apps'
 * @param {string} options.resourceLabel - lowercase singular noun for error messages, e.g. 'app'
 * @param {string[]} [options.requiredFields] - fields an uploaded config must contain
 * @param {(item: any, enabled: boolean) => any} [options.transformOnToggleAll]
 *   - override the default `{ ...item, enabled }` patch applied on bulk toggle
 * @param {boolean} [options.autoLoad] - set to false to skip the initial load
 *   (e.g. while a feature flag gating this resource is still off); re-enabling
 *   it triggers the load
 */
export function useAdminResourceList({
  fetchFn,
  toggleAllFn,
  resourcePath,
  resourceLabel,
  requiredFields = [],
  transformOnToggleAll,
  autoLoad = true
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(autoLoad);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchFn();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [fetchFn]);

  useEffect(() => {
    if (autoLoad) {
      load();
    }
  }, [autoLoad, load]);

  const toggleOne = useCallback(
    async id => {
      try {
        const response = await makeAdminApiCall(`/admin/${resourcePath}/${id}/toggle`, {
          method: 'POST'
        });
        const result = response.data;
        setItems(prev =>
          prev.map(item => (item.id === id ? { ...item, enabled: result.enabled } : item))
        );
        return result;
      } catch (err) {
        setError(err.message);
        throw err;
      }
    },
    [resourcePath]
  );

  const toggleAll = useCallback(
    async enabled => {
      try {
        await toggleAllFn('*', enabled);
        setItems(prev =>
          prev.map(item =>
            transformOnToggleAll ? transformOnToggleAll(item, enabled) : { ...item, enabled }
          )
        );
      } catch (err) {
        setError(err.message);
      }
    },
    [toggleAllFn, transformOnToggleAll]
  );

  const remove = useCallback(
    async id => {
      await makeAdminApiCall(`/admin/${resourcePath}/${id}`, { method: 'DELETE' });
      setItems(prev => prev.filter(item => item.id !== id));
    },
    [resourcePath]
  );

  const downloadConfig = useCallback(
    async id => {
      try {
        const response = await makeAdminApiCall(`/admin/${resourcePath}/${id}`);
        const configData = JSON.stringify(response.data, null, 2);
        const blob = new Blob([configData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${resourceLabel}-${id}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(`Failed to download ${resourceLabel} config: ${err.message}`);
      }
    },
    [resourcePath, resourceLabel]
  );

  const uploadConfig = useCallback(
    async event => {
      const file = event.target.files[0];
      if (!file) return;
      if (!file.name.endsWith('.json')) {
        setError('Please select a JSON file');
        return;
      }
      setUploading(true);
      let config;
      try {
        const fileContent = await file.text();
        config = JSON.parse(fileContent);
        const missingFields = requiredFields.filter(field => !config[field]);
        if (missingFields.length > 0) {
          throw new Error(
            `Invalid ${resourceLabel} config: missing required fields (${requiredFields.join(', ')})`
          );
        }
        await makeAdminApiCall(`/admin/${resourcePath}`, { method: 'POST', body: config });
        await load();
        event.target.value = '';
      } catch (err) {
        if (err.message.includes('already exists')) {
          setError(
            `${resourceLabel.charAt(0).toUpperCase()}${resourceLabel.slice(1)} with ID "${config?.id || 'unknown'}" already exists`
          );
        } else if (err instanceof SyntaxError) {
          setError('Invalid JSON file format');
        } else {
          setError(`Failed to upload ${resourceLabel} config: ${err.message}`);
        }
      } finally {
        setUploading(false);
      }
    },
    [resourcePath, resourceLabel, requiredFields, load]
  );

  return {
    items,
    setItems,
    loading: autoLoad ? loading : false,
    error,
    setError,
    uploading,
    load,
    toggleOne,
    toggleAll,
    remove,
    downloadConfig,
    uploadConfig
  };
}
