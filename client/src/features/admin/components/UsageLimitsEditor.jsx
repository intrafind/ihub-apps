// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchAdminModels, makeAdminApiCall } from '../../../api/adminApi';
import { localizedName } from '../../../shared/utils/usageFormat';
import Icon from '../../../shared/components/Icon';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from './formStyles';

/**
 * Editors for per-user token limits (`usageLimits`) on models, groups and users.
 *
 * Limit values (see `server/validators/common.js`):
 *   - an integer ≥ 0 is a limit in tokens (0 blocks),
 *   - -1 is "unlimited at this level" (lifts a limit another group would set),
 *   - a missing window sets no limit at this level (inherits).
 *
 * The model is the global per-user ceiling; groups and users can only lower it.
 */

/** The reset windows, in display order. */
export const USAGE_LIMIT_WINDOWS = ['day', 'week', 'month'];

const BYTES_PER_MB = 1024 * 1024;

/**
 * Turn what was typed into a limit value.
 *
 * @param {string} raw - The input's value
 * @returns {number|undefined|null} A limit, `undefined` for an empty field, or
 *   `null` when the text is not a valid limit (the caller keeps the old value)
 */
export function parseLimitInput(raw) {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < -1) return null;
  return n;
}

/**
 * The ceiling a window has at the level above, as a number ≥ 0, or `null`
 * when that level does not limit the window.
 *
 * @param {Object|undefined} bucket - `{ day?, week?, month? }`
 * @param {'day'|'week'|'month'} window
 * @returns {number|null}
 */
export function ceilingOf(bucket, window) {
  const value = bucket?.[window];
  return typeof value === 'number' && value >= 0 ? value : null;
}

/**
 * Drop empty windows from a bucket.
 *
 * @param {Object|undefined|null} bucket
 * @returns {Object|null} The cleaned bucket, or `null` when nothing is set
 */
export function normalizeLimitBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const out = {};
  for (const window of USAGE_LIMIT_WINDOWS) {
    const value = bucket[window];
    if (typeof value === 'number' && Number.isInteger(value) && value >= -1) out[window] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The `usageLimits` of a group or user, ready to save: empty windows, buckets
 * and model entries are dropped.
 *
 * @param {Object|undefined|null} limits - `{ allModels?, models?, fileStorageBytes? }`
 * @returns {Object|null} `null` when nothing is set (the server then clears it)
 *
 * @example
 * normalizeUsageLimits({ allModels: { day: 1000 }, models: { gpt: {} } });
 * // → { allModels: { day: 1000 } }
 */
export function normalizeUsageLimits(limits) {
  if (!limits || typeof limits !== 'object') return null;
  const out = {};
  const allModels = normalizeLimitBucket(limits.allModels);
  if (allModels) out.allModels = allModels;
  const models = {};
  for (const [modelId, bucket] of Object.entries(limits.models || {})) {
    const clean = normalizeLimitBucket(bucket);
    if (clean) models[modelId] = clean;
  }
  if (Object.keys(models).length) out.models = models;
  const bytes = limits.fileStorageBytes;
  if (typeof bytes === 'number' && Number.isInteger(bytes) && bytes >= -1) {
    out.fileStorageBytes = bytes;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Set or clear one window of a bucket.
 *
 * @param {Object|undefined} bucket
 * @param {'day'|'week'|'month'} window
 * @param {number|undefined} value - `undefined` clears the window
 * @returns {Object} A new bucket
 */
function withWindow(bucket, window, value) {
  const next = { ...(bucket || {}) };
  if (value === undefined) delete next[window];
  else next[window] = value;
  return next;
}

/** Bytes → MB for display (two decimals); -1 stays -1. */
export function bytesToMb(bytes) {
  if (typeof bytes !== 'number') return '';
  if (bytes === -1) return -1;
  return Math.round((bytes / BYTES_PER_MB) * 100) / 100;
}

/**
 * MB typed by the admin → bytes.
 *
 * @param {string} raw
 * @returns {number|undefined|null} bytes, `undefined` for empty, `null` if invalid
 */
export function mbInputToBytes(raw) {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -1) return null;
  if (n === -1) return -1;
  if (n < 0) return null;
  return Math.round(n * BYTES_PER_MB);
}

/**
 * Which model rows the group/user editor shows: the given model ids (`*`
 * expands to every model and adds the "All other models" row), plus any model
 * that already has an entry so a stale one can still be cleared.
 *
 * @param {Array<string>|undefined} modelIds - e.g. a group's `permissions.models`
 * @param {Array<Object>} models - All model configs
 * @param {Object|undefined} limitModels - The current `usageLimits.models`
 * @returns {{ rows: Array<{id: string, model: Object|null}>, wildcard: boolean }}
 */
export function limitModelRows(modelIds, models, limitModels) {
  const ids = Array.isArray(modelIds) ? modelIds : [];
  const wildcard = ids.includes('*') || Boolean(limitModels?.['*']);
  const byId = new Map(models.map(m => [m.id, m]));
  const wanted = new Set(ids.includes('*') ? models.map(m => m.id) : ids);
  for (const id of Object.keys(limitModels || {})) wanted.add(id);
  wanted.delete('*');
  const rows = [...wanted].map(id => ({ id, model: byId.get(id) || null }));
  return { rows, wildcard };
}

/**
 * Load what the group/user editor compares against: every model (with its own
 * `usageLimits`) and the platform's budget across all models.
 *
 * @returns {{ models: Array<Object>, allModelsCeiling: Object, loading: boolean }}
 */
export function useUsageLimitCeilings() {
  const [state, setState] = useState({ models: [], allModelsCeiling: {}, loading: true });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchAdminModels().catch(() => []),
      makeAdminApiCall('/admin/usage/limits/settings')
        .then(response => response.data?.allModels || {})
        .catch(() => ({}))
    ]).then(([models, allModelsCeiling]) => {
      if (!cancelled) setState({ models: models || [], allModelsCeiling, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * One limit input with its "above the ceiling" warning.
 *
 * @param {Object} props
 * @param {string} props.id - Input id
 * @param {string} props.label - Accessible label
 * @param {number|undefined} props.value
 * @param {number|null} props.ceiling - The level above's limit, or null
 * @param {'model'|'platform'} [props.ceilingKind] - Wording of the warning
 * @param {(value: number|undefined) => void} props.onChange
 * @param {boolean} [props.showLabel] - Render the label visibly
 * @param {number} [props.min] - -1 where "unlimited" is allowed, else 0
 * @param {boolean} [props.disabled]
 */
function LimitInput({
  id,
  label,
  value,
  ceiling,
  ceilingKind = 'model',
  onChange,
  showLabel = false,
  min = -1,
  disabled = false
}) {
  const { t, i18n } = useTranslation();
  const tooHigh = typeof value === 'number' && value >= 0 && ceiling !== null && value > ceiling;
  const ceilingText = ceiling !== null ? ceiling.toLocaleString(i18n.language) : null;
  const warningId = `${id}-warning`;

  return (
    <div className="min-w-[7rem]">
      <label htmlFor={id} className={showLabel ? LABEL_CLASS : 'sr-only'}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        step={1}
        inputMode="numeric"
        disabled={disabled}
        value={value ?? ''}
        placeholder={
          ceilingText !== null
            ? t('admin.usageLimits.placeholderCeiling', 'max {{limit}}', { limit: ceilingText })
            : t('admin.usageLimits.placeholderNoLimit', 'no limit')
        }
        onChange={e => {
          const parsed = parseLimitInput(e.target.value);
          if (parsed !== null) onChange(parsed);
        }}
        aria-invalid={tooHigh || undefined}
        aria-describedby={tooHigh ? warningId : undefined}
        className={`${INPUT_CLASS} tabular-nums ${tooHigh ? 'border-amber-500 dark:border-amber-500' : ''}`}
      />
      {tooHigh && (
        <p id={warningId} className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          {ceilingKind === 'platform'
            ? t(
                'admin.usageLimits.noEffectPlatform',
                'Has no effect — the platform allows at most {{limit}}',
                { limit: ceilingText }
              )
            : t(
                'admin.usageLimits.noEffectModel',
                'Has no effect — the model allows at most {{limit}}',
                { limit: ceilingText }
              )}
        </p>
      )}
    </div>
  );
}

/**
 * Daily / weekly / monthly token inputs for one bucket (`{ day?, week?, month? }`).
 * Used on its own by the model editor; the group/user editor uses it per row.
 *
 * @param {Object} props
 * @param {string} props.idPrefix - Prefix for the input ids (unique on the page)
 * @param {Object|undefined} props.value - The bucket
 * @param {(next: Object) => void} props.onChange - Receives the new bucket
 * @param {Object} [props.ceiling] - The level above's bucket (for hints)
 * @param {'model'|'platform'} [props.ceilingKind]
 * @param {boolean} [props.allowUnlimited] - Accept -1 (groups/users only)
 * @param {boolean} [props.showLabels] - Visible labels (stacked layout)
 * @param {boolean} [props.disabled]
 */
export function UsageLimitBucketFields({
  idPrefix,
  value,
  onChange,
  ceiling,
  ceilingKind = 'model',
  allowUnlimited = true,
  showLabels = true,
  disabled = false
}) {
  const { t } = useTranslation();
  const labels = {
    day: t('admin.usageLimits.window.day', 'Daily tokens'),
    week: t('admin.usageLimits.window.week', 'Weekly tokens'),
    month: t('admin.usageLimits.window.month', 'Monthly tokens')
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {USAGE_LIMIT_WINDOWS.map(window => (
        <LimitInput
          key={window}
          id={`${idPrefix}-${window}`}
          label={labels[window]}
          showLabel={showLabels}
          min={allowUnlimited ? -1 : 0}
          value={value?.[window]}
          ceiling={ceilingOf(ceiling, window)}
          ceilingKind={ceilingKind}
          disabled={disabled}
          onChange={next => {
            // The model level has no "unlimited" value: an empty field is unlimited.
            if (!allowUnlimited && next === -1) return;
            onChange(withWindow(value, window, next));
          }}
        />
      ))}
    </div>
  );
}

/** Value of the "Add a limit" list for each general limit. */
const ADD_ALL_MODELS = 'all';
const ADD_FILES = 'files';
const ADD_OTHER_MODELS = 'model:*';

/** Whether a stored `usageLimits` has an entry for a limit. */
function isConfigured(limits, key) {
  if (key === ADD_ALL_MODELS) return normalizeLimitBucket(limits.allModels) !== null;
  if (key === ADD_FILES) return typeof limits.fileStorageBytes === 'number';
  const modelId = key.slice('model:'.length);
  return normalizeLimitBucket(limits.models?.[modelId]) !== null;
}

/** One configured limit: a titled card with a Remove button. */
function LimitCard({ title, subtitle, note, removeLabel, onRemove, disabled, children }) {
  return (
    <section
      aria-label={title}
      className="rounded-md border border-gray-200 dark:border-gray-700 p-4"
      data-testid="usage-limit-card"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h4>
          {subtitle && (
            <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">{subtitle}</p>
          )}
          {note && <p className="text-xs text-amber-700 dark:text-amber-400">{note}</p>}
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={removeLabel}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-md disabled:opacity-50 focus:outline-hidden focus:ring-2 focus:ring-red-500"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>
      {children}
    </section>
  );
}

/**
 * The "Usage limits" section of the group and user editors. It lists only the
 * limits that are set, each as a card, and offers "Add a limit" for the ones
 * that are not: all models together, file storage, one model, or every other
 * model. A group or user without limits shows no input at all. Limits here can
 * only lower those of the model (and, for a user, of their groups).
 *
 * A card stays on screen while its fields are being cleared (an emptied limit
 * is dropped from the saved data, not from the page) until Remove is pressed.
 *
 * @param {Object} props
 * @param {Object|undefined} props.value - The current `usageLimits`
 * @param {(next: Object|undefined) => void} props.onChange - Receives the new
 *   `usageLimits` (`undefined` when nothing is set)
 * @param {Array<string>} [props.modelIds] - Models that can be limited (`*` = all)
 * @param {'group'|'user'} [props.level] - Changes the explanatory text
 * @param {boolean} [props.disabled]
 *
 * @example
 * <UsageLimitsEditor
 *   value={group.usageLimits}
 *   onChange={usageLimits => setGroup({ ...group, usageLimits })}
 *   modelIds={group.permissions?.models}
 *   level="group"
 * />
 */
function UsageLimitsEditor({ value, onChange, modelIds, level = 'group', disabled = false }) {
  const { t, i18n } = useTranslation();
  const { models, allModelsCeiling, loading } = useUsageLimitCeilings();
  const limits = value || {};
  const addId = useId();
  // Limits the admin added or edited here: they stay shown while empty.
  const [kept, setKept] = useState(() => new Set());
  const focusKeyRef = useRef(null);

  const idBase = `usage-limits-${level}`;
  const windowHeaders = {
    day: t('admin.usageLimits.window.dayShort', 'Daily'),
    week: t('admin.usageLimits.window.weekShort', 'Weekly'),
    month: t('admin.usageLimits.window.monthShort', 'Monthly')
  };

  /** The model rows a limit can be added for (`*` expands to every model). */
  const { rows: modelRows, wildcard } = useMemo(
    () => limitModelRows(modelIds, models, limits.models),
    [modelIds, models, limits.models]
  );
  const modelName = (id, model) => localizedName(model?.name, i18n.language, id);
  const rowById = useMemo(() => new Map(modelRows.map(row => [row.id, row])), [modelRows]);

  const keep = key =>
    setKept(previous => (previous.has(key) ? previous : new Set(previous).add(key)));
  const isShown = key => kept.has(key) || isConfigured(limits, key);

  // Focus the first field of a limit just added, once it is on the page.
  useEffect(() => {
    const key = focusKeyRef.current;
    if (!key) return;
    focusKeyRef.current = null;
    const targets = {
      [ADD_ALL_MODELS]: `${idBase}-all-day`,
      [ADD_FILES]: `${idBase}-files`,
      [ADD_OTHER_MODELS]: `${idBase}-model-wildcard-day`
    };
    const id = targets[key] || `${idBase}-model-${key.slice('model:'.length)}-day`;
    document.getElementById(id)?.focus();
  }, [kept, idBase]);

  /** Apply a change and hand the cleaned limits (or undefined) to the parent. */
  const update = next => onChange(normalizeUsageLimits(next) || undefined);

  const setModelBucket = (modelId, bucket) => {
    keep(`model:${modelId}`);
    update({ ...limits, models: { ...(limits.models || {}), [modelId]: bucket } });
  };

  const removeLimit = key => {
    const next = { ...limits };
    if (key === ADD_ALL_MODELS) delete next.allModels;
    else if (key === ADD_FILES) delete next.fileStorageBytes;
    else {
      const remaining = { ...(limits.models || {}) };
      delete remaining[key.slice('model:'.length)];
      next.models = remaining;
    }
    setKept(previous => {
      const rest = new Set(previous);
      rest.delete(key);
      return rest;
    });
    update(next);
  };

  const addLimit = key => {
    if (!key) return;
    focusKeyRef.current = key;
    keep(key);
  };

  // What is configured or kept, in a fixed order: general limits, models by name, the rest.
  const modelKeys = useMemo(() => {
    const ids = new Set(Object.keys(limits.models || {}));
    for (const key of kept) if (key.startsWith('model:')) ids.add(key.slice('model:'.length));
    ids.delete('*');
    return [...ids]
      .filter(id => isShown(`model:${id}`))
      .sort((a, b) =>
        modelName(a, rowById.get(a)?.model).localeCompare(modelName(b, rowById.get(b)?.model))
      );
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [limits.models, kept, rowById, i18n.language]);

  const showAll = isShown(ADD_ALL_MODELS);
  const showFiles = isShown(ADD_FILES);
  // A card the admin is editing stays, even when clearing it removed its `*` entry.
  const showOthers = isShown(ADD_OTHER_MODELS);
  const anyShown = showAll || showFiles || showOthers || modelKeys.length > 0;

  // The "Add a limit" options: what is not shown yet.
  const addGeneral = [
    ...(showAll
      ? []
      : [[ADD_ALL_MODELS, t('admin.usageLimits.addAllModels', 'All models together')]]),
    ...(showFiles ? [] : [[ADD_FILES, t('admin.usageLimits.addFileStorage', 'File storage')]]),
    ...(wildcard && !showOthers
      ? [[ADD_OTHER_MODELS, t('admin.usageLimits.otherModels', 'All other models')]]
      : [])
  ];
  const addModels = modelRows
    .filter(row => row.id !== '*' && !modelKeys.includes(row.id))
    .map(row => ({ id: row.id, label: modelName(row.id, row.model) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const nothingToAdd = addGeneral.length === 0 && addModels.length === 0;

  const fileMb = bytesToMb(limits.fileStorageBytes);
  const otherModelsLabel = t('admin.usageLimits.otherModels', 'All other models');

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {level === 'user'
            ? t('admin.usageLimits.userTitle', 'Personal usage limits')
            : t('admin.usageLimits.title', 'Usage limits')}
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {level === 'user'
            ? t(
                'admin.usageLimits.userIntro',
                "Personal limits for this user. They can only lower the limits of the model and of the user's groups."
              )
            : t(
                'admin.usageLimits.groupIntro',
                'Limits for each member of this group. They can only lower the limit of the model.'
              )}
        </p>
      </div>

      <div className="px-6 py-4 space-y-4">
        {!anyShown && (
          <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="usage-limits-empty">
            {level === 'user'
              ? t('admin.usageLimits.emptyUser', 'No personal limits are set.')
              : t('admin.usageLimits.emptyGroup', 'No limits are set for this group.')}
          </p>
        )}

        {showAll && (
          <LimitCard
            title={t('admin.usageLimits.allModelsTitle', 'All models')}
            subtitle={t(
              'admin.usageLimits.allModelsHint',
              'Tokens a user may use across all models together.'
            )}
            removeLabel={t('admin.usageLimits.removeLimit', 'Remove limit: {{name}}', {
              name: t('admin.usageLimits.allModelsTitle', 'All models')
            })}
            disabled={disabled}
            onRemove={() => removeLimit(ADD_ALL_MODELS)}
          >
            <UsageLimitBucketFields
              idPrefix={`${idBase}-all`}
              value={limits.allModels}
              ceiling={allModelsCeiling}
              ceilingKind="platform"
              disabled={disabled}
              onChange={bucket => {
                keep(ADD_ALL_MODELS);
                update({ ...limits, allModels: bucket });
              }}
            />
          </LimitCard>
        )}

        {showFiles && (
          <LimitCard
            title={t('admin.usageLimits.fileStorageTitle', 'File storage')}
            subtitle={t(
              'admin.usageLimits.fileStorageHint',
              'The most a user may keep in uploaded files. Empty means no limit at this level.'
            )}
            removeLabel={t('admin.usageLimits.removeLimit', 'Remove limit: {{name}}', {
              name: t('admin.usageLimits.fileStorageTitle', 'File storage')
            })}
            disabled={disabled}
            onRemove={() => removeLimit(ADD_FILES)}
          >
            <div className="max-w-xs">
              <label htmlFor={`${idBase}-files`} className={LABEL_CLASS}>
                {t('admin.usageLimits.fileStorageLabel', 'Storage limit (MB)')}
              </label>
              <input
                id={`${idBase}-files`}
                type="number"
                min={-1}
                step="any"
                inputMode="decimal"
                disabled={disabled}
                value={fileMb}
                placeholder={t('admin.usageLimits.placeholderNoLimit', 'no limit')}
                onChange={e => {
                  const bytes = mbInputToBytes(e.target.value);
                  if (bytes === null) return;
                  keep(ADD_FILES);
                  update({ ...limits, fileStorageBytes: bytes });
                }}
                className={`${INPUT_CLASS} tabular-nums`}
              />
            </div>
          </LimitCard>
        )}

        {modelKeys.map(id => {
          const model = rowById.get(id)?.model ?? models.find(entry => entry.id === id) ?? null;
          const name = modelName(id, model);
          return (
            <LimitCard
              key={id}
              title={name}
              subtitle={id}
              note={
                !loading && !model ? t('admin.usageLimits.unknownModel', 'Model not found') : null
              }
              removeLabel={t('admin.usageLimits.removeLimit', 'Remove limit: {{name}}', { name })}
              disabled={disabled}
              onRemove={() => removeLimit(`model:${id}`)}
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {USAGE_LIMIT_WINDOWS.map(window => (
                  <LimitInput
                    key={window}
                    id={`${idBase}-model-${id}-${window}`}
                    label={`${name} – ${windowHeaders[window]}`}
                    showLabel
                    value={limits.models?.[id]?.[window]}
                    ceiling={ceilingOf(model?.usageLimits, window)}
                    disabled={disabled}
                    onChange={next =>
                      setModelBucket(id, withWindow(limits.models?.[id], window, next))
                    }
                  />
                ))}
              </div>
            </LimitCard>
          );
        })}

        {showOthers && (
          <LimitCard
            title={otherModelsLabel}
            subtitle={t('admin.usageLimits.otherModelsHint', 'Each model without its own limit')}
            removeLabel={t('admin.usageLimits.removeLimit', 'Remove limit: {{name}}', {
              name: otherModelsLabel
            })}
            disabled={disabled}
            onRemove={() => removeLimit(ADD_OTHER_MODELS)}
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {USAGE_LIMIT_WINDOWS.map(window => (
                <LimitInput
                  key={window}
                  id={`${idBase}-model-wildcard-${window}`}
                  label={`${otherModelsLabel} – ${windowHeaders[window]}`}
                  showLabel
                  value={limits.models?.['*']?.[window]}
                  ceiling={null}
                  disabled={disabled}
                  onChange={next =>
                    setModelBucket('*', withWindow(limits.models?.['*'], window, next))
                  }
                />
              ))}
            </div>
          </LimitCard>
        )}

        {/* Add a limit */}
        <div>
          <label htmlFor={addId} className="sr-only">
            {t('admin.usageLimits.addLabel', 'Add a limit')}
          </label>
          <select
            id={addId}
            value=""
            disabled={disabled || nothingToAdd}
            onChange={event => addLimit(event.target.value)}
            className={`${INPUT_CLASS} max-w-xs`}
          >
            <option value="">
              {loading
                ? t('admin.usageLimits.loadingModels', 'Loading models…')
                : nothingToAdd
                  ? t('admin.usageLimits.nothingToAdd', 'Every limit has been added.')
                  : t('admin.usageLimits.addPlaceholder', 'Add a limit…')}
            </option>
            {addGeneral.length > 0 && (
              <optgroup label={t('admin.usageLimits.addGeneral', 'General')}>
                {addGeneral.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </optgroup>
            )}
            {addModels.length > 0 && (
              <optgroup label={t('admin.usageLimits.addModel', 'Per model')}>
                {addModels.map(({ id, label }) => (
                  <option key={id} value={`model:${id}`}>
                    {label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <p className={HELP_CLASS}>
            {level === 'user'
              ? t(
                  'admin.usageLimits.emptyHintUser',
                  'An empty field means no personal limit. 0 blocks the model for this user.'
                )
              : t(
                  'admin.usageLimits.emptyHintGroup',
                  'An empty field means no limit from this group. A member of several groups gets the most generous group limit; enter -1 to lift a limit that other groups of a member set. 0 blocks.'
                )}
          </p>
          {level === 'group' && !loading && modelRows.length === 0 && !wildcard && (
            <p className={HELP_CLASS}>
              {t(
                'admin.usageLimits.noModelsGroup',
                'This group has no model permissions. Add models under Permissions to limit them here.'
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default UsageLimitsEditor;
