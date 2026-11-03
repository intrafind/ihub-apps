// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchAdminModels, makeAdminApiCall } from '../../../api/adminApi';
import { localizedName } from '../../../shared/utils/usageFormat';
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
  if (raw === '' || raw === null || raw === undefined) return undefined;
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
  if (raw === '' || raw === null || raw === undefined) return undefined;
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
    Promise.all([
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

/**
 * The "Usage limits" section of the group and user editors: a budget across
 * all models, a file storage limit and per-model limits. Limits here can only
 * lower those of the model (and, for a user, of their groups).
 *
 * @param {Object} props
 * @param {Object|undefined} props.value - The current `usageLimits`
 * @param {(next: Object|undefined) => void} props.onChange - Receives the new
 *   `usageLimits` (`undefined` when nothing is set)
 * @param {Array<string>} [props.modelIds] - Model ids to list (`*` = all)
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

  const { rows, wildcard } = useMemo(
    () => limitModelRows(modelIds, models, limits.models),
    [modelIds, models, limits.models]
  );
  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) =>
        localizedName(a.model?.name, i18n.language, a.id).localeCompare(
          localizedName(b.model?.name, i18n.language, b.id)
        )
      ),
    [rows, i18n.language]
  );

  /** Apply a change and hand the cleaned limits (or undefined) to the parent. */
  const update = next => onChange(normalizeUsageLimits(next) || undefined);

  const setModelBucket = (modelId, bucket) =>
    update({ ...limits, models: { ...(limits.models || {}), [modelId]: bucket } });

  const fileMb = bytesToMb(limits.fileStorageBytes);
  const idBase = `usage-limits-${level}`;
  const windowHeaders = {
    day: t('admin.usageLimits.window.dayShort', 'Daily'),
    week: t('admin.usageLimits.window.weekShort', 'Weekly'),
    month: t('admin.usageLimits.window.monthShort', 'Monthly')
  };

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
      </div>

      <div className="px-6 py-4 space-y-6">
        {/* All models */}
        <section aria-labelledby={`${idBase}-all-heading`}>
          <h4
            id={`${idBase}-all-heading`}
            className="text-sm font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.usageLimits.allModelsTitle', 'All models')}
          </h4>
          <p className={`${HELP_CLASS} mb-3`}>
            {t(
              'admin.usageLimits.allModelsHint',
              'Tokens a user may use across all models together.'
            )}
          </p>
          <UsageLimitBucketFields
            idPrefix={`${idBase}-all`}
            value={limits.allModels}
            ceiling={allModelsCeiling}
            ceilingKind="platform"
            disabled={disabled}
            onChange={bucket => update({ ...limits, allModels: bucket })}
          />
        </section>

        {/* File storage */}
        <section aria-labelledby={`${idBase}-files-heading`}>
          <h4
            id={`${idBase}-files-heading`}
            className="text-sm font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.usageLimits.fileStorageTitle', 'File storage')}
          </h4>
          <div className="mt-2 max-w-xs">
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
                update({ ...limits, fileStorageBytes: bytes });
              }}
              className={`${INPUT_CLASS} tabular-nums`}
            />
          </div>
          <p className={HELP_CLASS}>
            {t(
              'admin.usageLimits.fileStorageHint',
              'The most a user may keep in uploaded files. Empty means no limit at this level.'
            )}
          </p>
        </section>

        {/* Per model */}
        <section aria-labelledby={`${idBase}-models-heading`}>
          <h4
            id={`${idBase}-models-heading`}
            className="text-sm font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.usageLimits.perModelTitle', 'Per model')}
          </h4>
          <p className={`${HELP_CLASS} mb-3`}>
            {t(
              'admin.usageLimits.perModelHint',
              "Tokens a user may use of one model. The placeholder shows the model's own limit."
            )}
          </p>

          {loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('admin.usageLimits.loadingModels', 'Loading models…')}
            </p>
          ) : sortedRows.length === 0 && !wildcard ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {level === 'user'
                ? t('admin.usageLimits.noModels', 'No models available.')
                : t(
                    'admin.usageLimits.noModelsGroup',
                    'This group has no model permissions. Add models under Permissions to limit them here.'
                  )}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead>
                  <tr>
                    <th
                      scope="col"
                      className="py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                      {t('admin.usageLimits.modelColumn', 'Model')}
                    </th>
                    {USAGE_LIMIT_WINDOWS.map(window => (
                      <th
                        key={window}
                        scope="col"
                        className="py-2 px-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                      >
                        {windowHeaders[window]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedRows.map(({ id, model }) => {
                    const name = localizedName(model?.name, i18n.language, id);
                    return (
                      <tr key={id} className="align-top">
                        <th scope="row" className="py-2 pr-4 text-left font-normal">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {name}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                            {id}
                          </div>
                          {!model && (
                            <div className="text-xs text-amber-700 dark:text-amber-400">
                              {t('admin.usageLimits.unknownModel', 'Model not found')}
                            </div>
                          )}
                        </th>
                        {USAGE_LIMIT_WINDOWS.map(window => (
                          <td key={window} className="py-2 px-2">
                            <LimitInput
                              id={`${idBase}-model-${id}-${window}`}
                              label={`${name} – ${windowHeaders[window]}`}
                              value={limits.models?.[id]?.[window]}
                              ceiling={ceilingOf(model?.usageLimits, window)}
                              disabled={disabled}
                              onChange={next =>
                                setModelBucket(id, withWindow(limits.models?.[id], window, next))
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  {wildcard && (
                    <tr className="align-top">
                      <th scope="row" className="py-2 pr-4 text-left font-normal">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {t('admin.usageLimits.otherModels', 'All other models')}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {t(
                            'admin.usageLimits.otherModelsHint',
                            'Each model without its own entry above'
                          )}
                        </div>
                      </th>
                      {USAGE_LIMIT_WINDOWS.map(window => (
                        <td key={window} className="py-2 px-2">
                          <LimitInput
                            id={`${idBase}-model-wildcard-${window}`}
                            label={`${t('admin.usageLimits.otherModels', 'All other models')} – ${windowHeaders[window]}`}
                            value={limits.models?.['*']?.[window]}
                            ceiling={null}
                            disabled={disabled}
                            onChange={next =>
                              setModelBucket('*', withWindow(limits.models?.['*'], window, next))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default UsageLimitsEditor;
