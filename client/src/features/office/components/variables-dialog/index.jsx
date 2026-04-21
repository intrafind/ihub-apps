import { useState, useEffect, useCallback, useMemo } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { officeLocale } from '../../utilities/officeLocale';

export function getValidVariableDefinitions(variables) {
  if (!Array.isArray(variables)) return [];
  return variables.filter(v => {
    if (!v || typeof v.name !== 'string' || !v.name.trim()) return false;
    if (!v.label || typeof v.label !== 'object') return false;
    if (v.label.en == null && v.label.de == null) return false;
    if (typeof v.type !== 'string' || !v.type) return false;
    return true;
  });
}

export function missingRequiredVariableNames(definitions, values) {
  return definitions.filter(d => d.required === true && !String(values[d.name] ?? '').trim());
}

function labelForDef(variable) {
  const l = variable?.label;
  if (!l || typeof l !== 'object') return variable?.name ?? '';
  return getLocalizedContent(l, officeLocale) || variable?.name || '';
}

export function mergeStarterPromptVariablesIntoValues(
  appVariablesSchema,
  promptVariablesObj,
  baseValues
) {
  if (!promptVariablesObj || typeof promptVariablesObj !== 'object') {
    return baseValues;
  }
  const defs = getValidVariableDefinitions(appVariablesSchema);
  if (defs.length === 0) return baseValues;
  const next = { ...baseValues };
  for (const [key, val] of Object.entries(promptVariablesObj)) {
    if (val == null) continue;
    const strVal = String(val);
    const keyNorm = String(key).trim().toLowerCase();
    const def = defs.find(d => {
      if (d.name === key || d.name.trim().toLowerCase() === keyNorm) return true;
      const en = String(d.label?.en ?? '')
        .trim()
        .toLowerCase();
      const de = String(d.label?.de ?? '')
        .trim()
        .toLowerCase();
      return en === keyNorm || (de && de === keyNorm);
    });
    if (def) {
      next[def.name] = strVal;
    }
  }
  return next;
}

function defaultValueLocalized(variable) {
  const d = variable?.defaultValue;
  if (d == null) return '';
  if (typeof d === 'object') return String(getLocalizedContent(d, officeLocale));
  return String(d);
}

export function initialValueForDefinition(def) {
  const preset = Array.isArray(def.predefinedValues) ? def.predefinedValues : [];
  const dv = defaultValueLocalized(def);

  if (preset.length > 0) {
    const keys = preset.map(p => String(p.value));
    if (dv !== '' && keys.includes(String(dv))) return String(dv);
    if (dv !== '') {
      const byLabel = preset.find(
        p => String(p.label?.en ?? '') === dv || String(p.label?.de ?? '') === dv
      );
      if (byLabel) return String(byLabel.value);
    }
    return keys[0] != null ? String(keys[0]) : '';
  }

  return dv;
}

export function buildInitialVariablesMap(variables) {
  const defs = getValidVariableDefinitions(variables);
  const out = {};
  for (const d of defs) {
    out[d.name] = initialValueForDefinition(d);
  }
  return out;
}

function isMultilineType(type) {
  const t = String(type).toLowerCase();
  return t === 'text' || t === 'multiline' || t === 'textarea';
}

function htmlInputType(variableType) {
  const t = String(variableType).toLowerCase();
  if (t === 'number' || t === 'integer' || t === 'float') return 'number';
  if (t === 'email') return 'email';
  if (t === 'url') return 'url';
  if (t === 'password') return 'password';
  if (t === 'date') return 'date';
  return 'text';
}

function seedValuesFromProps(definitions, currentValues) {
  const next = {};
  for (const def of definitions) {
    if (currentValues && Object.prototype.hasOwnProperty.call(currentValues, def.name)) {
      next[def.name] = String(currentValues[def.name] ?? '');
    } else {
      next[def.name] = initialValueForDefinition(def);
    }
  }
  return next;
}

export default function VariablesDialog({
  variables = [],
  currentValues = null,
  closeRequiresRequiredComplete = false,
  isOpen,
  onClose,
  onCancel,
  onSave
}) {
  const definitions = useMemo(() => getValidVariableDefinitions(variables), [variables]);
  const [values, setValues] = useState({});
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setSaveError(null);
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setValues(seedValuesFromProps(definitions, currentValues));
  }, [isOpen, definitions, currentValues]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = e => {
      if (e.key === 'Escape' && !closeRequiresRequiredComplete) onClose?.();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, closeRequiresRequiredComplete, onClose]);

  const setField = useCallback((name, value) => {
    setValues(prev => ({ ...prev, [name]: value != null ? String(value) : '' }));
    setSaveError(null);
  }, []);

  const reset = useCallback(() => {
    setValues({});
    setSaveError(null);
  }, []);

  const closeParent = useCallback(() => {
    reset();
    onClose?.();
  }, [onClose, reset]);

  const attemptDismiss = useCallback(() => {
    if (definitions.length === 0) {
      closeParent();
      return;
    }
    if (closeRequiresRequiredComplete) {
      const missing = missingRequiredVariableNames(definitions, values);
      if (missing.length > 0) {
        const names = missing.map(m => labelForDef(m)).join(', ');
        setSaveError(`Fill all required fields before closing: ${names}`);
        return;
      }
      if (typeof onSave === 'function') {
        const out = {};
        for (const d of definitions) {
          out[d.name] = String(values[d.name] ?? '');
        }
        onSave(out);
      }
    }
    closeParent();
  }, [definitions, values, closeRequiresRequiredComplete, closeParent, onSave]);

  const handleSave = useCallback(() => {
    if (definitions.length === 0) {
      closeParent();
      return;
    }
    const missing = missingRequiredVariableNames(definitions, values);
    if (missing.length > 0) {
      const names = missing.map(m => labelForDef(m)).join(', ');
      setSaveError(`Please fill required fields: ${names}`);
      return;
    }
    if (typeof onSave === 'function') {
      const out = {};
      for (const d of definitions) {
        out[d.name] = String(values[d.name] ?? '');
      }
      onSave(out);
    }
    closeParent();
  }, [definitions, values, onSave, closeParent]);

  if (!isOpen) return null;

  const subText =
    definitions.length === 0
      ? 'This app has no configurable variables.'
      : closeRequiresRequiredComplete
        ? 'Fill all required fields, then save or close.'
        : "Set values used in this app's prompts.";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => {
        if (e.target === e.currentTarget && !closeRequiresRequiredComplete) attemptDismiss();
      }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">Variables</h2>
          {!closeRequiresRequiredComplete && (
            <button
              type="button"
              onClick={attemptDismiss}
              aria-label="Close"
              className="rounded-full p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
            >
              <XMarkIcon className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>

        <div className="p-4 flex flex-col gap-3">
          <p className="text-sm text-slate-500">{subText}</p>

          {saveError && (
            <p className="text-sm text-red-600 break-words" role="alert">
              {saveError}
            </p>
          )}

          {definitions.map(def => {
            const fieldLabel = labelForDef(def);
            const required = def.required === true;
            const presets = Array.isArray(def.predefinedValues) ? def.predefinedValues : [];

            if (presets.length > 0) {
              return (
                <div key={def.name} className="flex flex-col gap-1">
                  <label className="text-sm font-medium text-slate-700">
                    {fieldLabel}
                    {required && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  <select
                    value={values[def.name] ?? ''}
                    onChange={e => setField(def.name, e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  >
                    {presets.map(p => (
                      <option key={String(p.value)} value={String(p.value)}>
                        {p.label != null
                          ? getLocalizedContent(p.label, officeLocale)
                          : String(p.value)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }

            if (isMultilineType(def.type)) {
              return (
                <div key={def.name} className="flex flex-col gap-1">
                  <label className="text-sm font-medium text-slate-700">
                    {fieldLabel}
                    {required && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  <textarea
                    rows={4}
                    value={values[def.name] ?? ''}
                    onChange={e => setField(def.name, e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
                  />
                </div>
              );
            }

            return (
              <div key={def.name} className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700">
                  {fieldLabel}
                  {required && <span className="text-red-500 ml-1">*</span>}
                </label>
                <input
                  type={htmlInputType(def.type)}
                  value={values[def.name] ?? ''}
                  onChange={e => setField(def.name, e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200">
          <button
            type="button"
            onClick={() => {
              reset();
              (onCancel ?? onClose)?.();
            }}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-lg px-4 py-2 text-sm font-medium bg-slate-900 text-white hover:bg-slate-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
