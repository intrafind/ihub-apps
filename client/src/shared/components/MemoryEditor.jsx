import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Whether a failed save was a version conflict. Agent memory (admin API) and
 * scheduled-task memory (user API) report it in different shapes, so both are
 * checked: `{ error: 'VERSION_CONFLICT' }` on the raw response and `code` on
 * the error the API client builds.
 *
 * @param {*} err
 * @returns {boolean}
 */
export function isVersionConflict(err) {
  const data = err?.response?.data ?? err?.originalError?.response?.data;
  return (
    err?.code === 'VERSION_CONFLICT' ||
    data?.error === 'VERSION_CONFLICT' ||
    data?.code === 'VERSION_CONFLICT'
  );
}

function defaultFormatError(err) {
  return err?.response?.data?.message || err?.message || String(err);
}

/**
 * Editor for a long-term memory document: markdown notes with a version.
 *
 * Shared by the admin agent memory page and the scheduled task page. It knows
 * nothing about where the notes live: the page passes `load` and `save`.
 *
 * The state belongs to `id`, not to whatever object the page polls. A page
 * that re-renders every few seconds (a task page follows a running task) does
 * not touch unsaved text; when the notes change underneath an edit
 * (`reloadKey` changes), the editor says so and lets the user choose.
 *
 * @param {Object} props
 * @param {string|number} props.id - Identity of the notes; a new id loads again.
 * @param {() => Promise<{body?: string, version?: number, updatedAt?: string|null, updatedBy?: string|null}>} props.load
 * @param {(payload: {content: string, expectedVersion: number}) => Promise<{version?: number, updatedAt?: string}|void>} props.save
 * @param {() => Promise<*>} [props.clear] - Adds a "Clear" button.
 * @param {(err: *) => boolean} [props.isConflict]
 * @param {(err: *) => string} [props.formatError]
 * @param {*} [props.reloadKey] - Change it when the stored notes may have changed.
 * @param {boolean} [props.readOnly]
 * @param {number} [props.maxChars] - Shows a size meter and blocks saving above it.
 * @param {React.ReactNode} [props.notice] - A line above the editor.
 * @param {React.ReactNode} [props.children] - A slot between the toolbar and the text area.
 * @param {string} [props.heightClassName]
 * @param {(result: *) => void} [props.onSaved]
 */
export default function MemoryEditor({
  id,
  load,
  save,
  clear,
  isConflict = isVersionConflict,
  formatError = defaultFormatError,
  reloadKey,
  readOnly = false,
  maxChars,
  notice,
  children,
  heightClassName = 'h-[500px]',
  onSaved
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [savedBody, setSavedBody] = useState('');
  const [version, setVersion] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [updatedBy, setUpdatedBy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [stale, setStale] = useState(false);

  // The page's callbacks change identity on every render; the effects below
  // must depend on `id` and `reloadKey` only.
  const callbacksRef = useRef({});
  callbacksRef.current = { load, save, clear, formatError };
  const requestIdRef = useRef(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = body !== savedBody;

  const doLoad = useCallback(async ({ silent = false } = {}) => {
    const mine = ++requestIdRef.current;
    if (!silent) setLoading(true);
    try {
      const data = (await callbacksRef.current.load()) || {};
      if (mine !== requestIdRef.current) return;
      const text = data.body || '';
      setBody(text);
      setSavedBody(text);
      setVersion(data.version || 0);
      setUpdatedAt(data.updatedAt || null);
      setUpdatedBy(data.updatedBy || null);
      setError(null);
      setConflict(false);
      setStale(false);
    } catch (err) {
      if (mine !== requestIdRef.current) return;
      setError(callbacksRef.current.formatError(err));
    } finally {
      if (mine === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    doLoad();
    return () => {
      requestIdRef.current += 1;
    };
  }, [id, doLoad]);

  const firstReloadKeyRef = useRef(true);
  useEffect(() => {
    if (firstReloadKeyRef.current) {
      firstReloadKeyRef.current = false;
      return;
    }
    if (dirtyRef.current) setStale(true);
    else doLoad({ silent: true });
  }, [reloadKey, doLoad]);

  const overLimit = Number.isFinite(maxChars) && body.length > maxChars;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const result = await callbacksRef.current.save({ content: body, expectedVersion: version });
      setVersion(result?.version ?? version + 1);
      if (result?.updatedAt) setUpdatedAt(result.updatedAt);
      setSavedBody(body);
      setStale(false);
      if (onSaved) onSaved(result);
    } catch (err) {
      if (isConflict(err)) {
        setConflict(true);
        setError(
          t(
            'memoryEditor.versionConflict',
            'Conflict: memory was modified elsewhere. Reload to see the latest.'
          )
        );
      } else {
        setError(formatError(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (
      !window.confirm(
        t('memoryEditor.clearConfirm', 'Clear all notes? This removes everything written so far.')
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await callbacksRef.current.clear();
      await doLoad({ silent: true });
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-gray-600 dark:text-gray-400">
        {t('common.loading', 'Loading…')}
      </div>
    );
  }

  const versionLine = [
    t('memoryEditor.versionLine', 'Version {{version}}', { version }),
    updatedAt ? t('memoryEditor.updatedAt', 'updated {{at}}', { at: updatedAt }) : null,
    updatedBy ? t('memoryEditor.updatedBy', 'by {{by}}', { by: updatedBy }) : null
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="memory-version">
          {versionLine}
          {Number.isFinite(maxChars) && (
            <span
              className={`ml-2 ${overLimit ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}
              data-testid="memory-size"
            >
              {t('memoryEditor.size', '{{chars}} / {{max}} characters', {
                chars: body.length,
                max: maxChars
              })}
            </span>
          )}
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            {clear && (
              <button
                type="button"
                onClick={handleClear}
                disabled={saving}
                className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-sm text-sm disabled:opacity-50"
              >
                {t('memoryEditor.clear', 'Clear')}
              </button>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || overLimit || body === savedBody}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-sm text-sm disabled:opacity-50"
            >
              {saving ? t('memoryEditor.saving', 'Saving…') : t('memoryEditor.save', 'Save')}
            </button>
          </div>
        )}
      </div>

      {notice && (
        <div className="mb-3 text-sm text-gray-600 dark:text-gray-300" data-testid="memory-notice">
          {notice}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded-sm flex flex-wrap items-center justify-between gap-2"
        >
          <span>{error}</span>
          {conflict && (
            <button
              type="button"
              onClick={() => doLoad({ silent: true })}
              className="px-2 py-1 text-sm border border-red-300 dark:border-red-700 rounded-sm hover:bg-red-100 dark:hover:bg-red-900/40"
            >
              {t('memoryEditor.reload', 'Reload (discard my edits)')}
            </button>
          )}
        </div>
      )}

      {stale && !conflict && (
        <div
          role="status"
          className="mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 rounded-sm text-sm flex flex-wrap items-center justify-between gap-2"
        >
          <span>
            {t(
              'memoryEditor.staleNotice',
              'The notes changed since you started editing (a run may have updated them).'
            )}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={() => doLoad({ silent: true })}
              className="px-2 py-1 border border-amber-300 dark:border-amber-700 rounded-sm hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              {t('memoryEditor.reload', 'Reload (discard my edits)')}
            </button>
            <button
              type="button"
              onClick={() => setStale(false)}
              className="px-2 py-1 border border-amber-300 dark:border-amber-700 rounded-sm hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              {t('memoryEditor.keepEditing', 'Keep editing')}
            </button>
          </span>
        </div>
      )}

      {children}

      <textarea
        aria-label={t('memoryEditor.label', 'Memory notes')}
        className={`w-full ${heightClassName} font-mono text-sm p-3 border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 read-only:opacity-70`}
        value={body}
        readOnly={readOnly}
        onChange={e => setBody(e.target.value)}
      />
    </div>
  );
}
