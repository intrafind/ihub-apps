import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/**
 * Applies app-settings query params (model/style/outfmt/temp/history/var_*) once
 * app data is loaded, then strips them from the URL. Shared between AppChat and
 * AppCanvas so the parsing/cleanup logic only needs to be fixed in one place.
 *
 * @param {Object} app - The loaded app configuration (effect no-ops until truthy)
 * @param {boolean} modelsLoading - Effect no-ops while models are still loading
 * @param {Object} setters - { setSelectedModel, setSelectedStyle, setSelectedOutputFormat, setTemperature, setSendChatHistory }
 * @param {Object} [options]
 * @param {string[]} [options.extraParamsToStrip] - Additional query params to remove alongside the recognized ones
 * @param {(vars: Object) => void} [options.onVariables] - Called with parsed var_* params, keyed without the prefix
 */
function useUrlParamSettings(app, modelsLoading, setters, options = {}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const {
    setSelectedModel,
    setSelectedStyle,
    setSelectedOutputFormat,
    setTemperature,
    setSendChatHistory
  } = setters;
  const { extraParamsToStrip = [], onVariables } = options;

  useEffect(() => {
    if (!app || modelsLoading) return;

    const newVars = {};
    let changed = false;

    const m = searchParams.get('model');
    if (m) {
      setSelectedModel(m);
      changed = true;
    }
    const st = searchParams.get('style');
    if (st) {
      setSelectedStyle(st);
      changed = true;
    }
    const out = searchParams.get('outfmt');
    if (out) {
      setSelectedOutputFormat(out);
      changed = true;
    }
    const tempParam = searchParams.get('temp');
    if (tempParam) {
      setTemperature(parseFloat(tempParam));
      changed = true;
    }
    const hist = searchParams.get('history');
    if (hist) {
      setSendChatHistory(hist === 'true');
      changed = true;
    }

    searchParams.forEach((value, key) => {
      if (key.startsWith('var_')) {
        newVars[key.slice(4)] = value;
        changed = true;
      }
    });

    if (Object.keys(newVars).length) {
      onVariables?.(newVars);
    }

    if (changed) {
      const newSearch = new URLSearchParams(searchParams);
      [
        'model',
        'style',
        'outfmt',
        'temp',
        'history',
        ...extraParamsToStrip,
        ...Object.keys(newVars).map(v => `var_${v}`)
      ].forEach(k => newSearch.delete(k));
      navigate(`${window.location.pathname}?${newSearch.toString()}`, { replace: true });
    }
  }, [
    app,
    modelsLoading,
    navigate,
    searchParams,
    setSelectedModel,
    setSelectedOutputFormat,
    setSelectedStyle,
    setSendChatHistory,
    setTemperature
  ]);
}

export default useUrlParamSettings;
