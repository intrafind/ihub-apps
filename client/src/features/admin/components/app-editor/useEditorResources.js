// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';

/**
 * What the app editor needs beside the app: the models the author may use,
 * the UI configuration (the categories) and the JSON schema of an app.
 *
 * Each is loaded once through the caller's function. The form works without
 * each of them, and the server stays the authority, so a failed load is only
 * logged and its value stays `null`. For the models, `null` therefore means
 * "not known", which is not the same as an empty list ("no model").
 *
 * The three functions must keep their identity between renders.
 *
 * @param {object} sources
 * @param {() => Promise<object[]>} sources.fetchModels
 * @param {() => Promise<object>} sources.fetchUiConfig
 * @param {() => Promise<object>} sources.fetchSchema
 * @returns {{models: object[]|null, uiConfig: object|null, jsonSchema: object|null}}
 */
export function useEditorResources({ fetchModels, fetchUiConfig, fetchSchema }) {
  const [models, setModels] = useState(null);
  const [uiConfig, setUiConfig] = useState(null);
  const [jsonSchema, setJsonSchema] = useState(null);

  useEffect(() => {
    let current = true;
    const load = (what, fetcher, apply) =>
      Promise.resolve()
        .then(fetcher)
        .then(value => current && apply(value))
        .catch(error => console.error(`Failed to load ${what}:`, error));
    void load('models', fetchModels, value => setModels(Array.isArray(value) ? value : null));
    void load('UI config', fetchUiConfig, value => setUiConfig(value || null));
    void load('app JSON schema', fetchSchema, value => setJsonSchema(value || null));
    return () => {
      current = false;
    };
  }, [fetchModels, fetchUiConfig, fetchSchema]);

  return { models, uiConfig, jsonSchema };
}

export default useEditorResources;
