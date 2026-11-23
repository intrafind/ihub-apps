// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, use, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pickText } from '../ConfigFieldInput';
import { buildActionsPolicy, initialCheckedActions } from '../actionsPolicy';
import { buildInstallationPayload } from '../installationPayload';
import {
  testInstalledIntegration,
  updateInstalledIntegration
} from '../../../../../api/integrationsAdminApi';
import { fetchAdminGroups, getAdminApiErrorMessage } from '../../../../../api/adminApi';
import { groupsGranting } from '../../../utils/groupIntegrationAccess';
import { DirtyReportContext, useDirtyReport } from '../../../hooks/useDirtyReport';

/**
 * What a page hosting an editor offers it so the page's save bar can save the editor
 * (`AdminInstallationPage`). The value is `{ saveRef, setError }`: the editor puts its save
 * in `saveRef.current` (see {@link useInstallationEditorSave}) and reports why a save failed
 * through `setError`. Without a host the editor draws its own Save and Cancel buttons.
 *
 * @type {React.Context<{ saveRef: { current: (() => Promise<boolean>)|null }, setError: (message: string|null) => void }|undefined>}
 */
export const EditorSaveContext = createContext(undefined);

/** `GET /api/admin/groups` → `groups` (id → group), or an empty object. */
function groupsOf(groupsResult) {
  return groupsResult?.groups && typeof groupsResult.groups === 'object' ? groupsResult.groups : {};
}

/** The server's validation details as one line, e.g. `baseUrl: must be a URL`. */
function detailText(err) {
  const issues = err?.response?.data?.details?.issues;
  if (!Array.isArray(issues)) return '';
  return issues
    .map(d => (d?.key ? `${d.key}: ${d.message}` : d?.message))
    .filter(Boolean)
    .join('; ');
}

/**
 * The state every dedicated installation editor shares, so an editor only
 * owns its install values: the label and description (in the admin's
 * language, other languages kept), the groups that grant it, the action switches, the test
 * of the unsaved values and the save.
 *
 * - **Test** sends the edited installation to
 *   `POST /api/admin/integrations/installed/:id/_test`, which runs the
 *   connector's test against the draft without saving it.
 * - **Save** sends it to `PUT /api/admin/integrations/installed/:id` and calls
 *   `onSaved` with the stored installation.
 *
 * Field errors of the server (`INVALID_VALUES`) land in `fieldErrors` keyed by
 * install field.
 *
 * @param {Object} params
 * @param {Object} params.instance - see the editor contract in `editors/index.js`
 * @param {Object} params.definition - the definition detail
 * @param {(saved: Object) => void} params.onSaved
 * @returns {Object} editor state and actions (see the returned object)
 */
export default function useInstallationEditor({ instance, definition, onSaved }) {
  const { i18n } = useTranslation();
  const lang = i18n.language || 'en';

  // The groups that grant this installation (`permissions.integrations`),
  // null until loaded.
  const [grantedTo, setGrantedTo] = useState(null);
  const [label, setLabel] = useState(() => pickText(instance.labelLocalized, lang) || '');
  const [description, setDescription] = useState(() => pickText(instance.description, lang) || '');
  const [{ knownActions, checked: initialChecked }] = useState(() =>
    initialCheckedActions({ definition, instance, liveActions: instance.liveActions || [] })
  );
  const [checkedActions, setCheckedActions] = useState(initialChecked);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const grantId = instance.id;
  const grantDefinition = instance.definition;
  const grantType = definition?.type || null;
  useEffect(() => {
    const grantTarget = { id: grantId, definition: grantDefinition, type: grantType };
    let cancelled = false;
    fetchAdminGroups()
      .then(result => {
        if (!cancelled) setGrantedTo(groupsGranting(grantTarget, groupsOf(result)));
      })
      .catch(() => {
        if (!cancelled) setGrantedTo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [grantId, grantDefinition, grantType]);

  const toggleAction = (name, on) =>
    setCheckedActions(prev => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  /**
   * The PUT / test body with these install values and everything else from
   * the editor. `extra.labelMap` / `extra.descriptionMap` replace the label
   * and description in every language (an editor that edits all of them).
   */
  const buildPayload = (values, extra = {}) =>
    buildInstallationPayload(instance, {
      values,
      lang,
      label,
      description,
      labelMap: extra.labelMap,
      descriptionMap: extra.descriptionMap,
      actions: buildActionsPolicy({
        knownActions,
        checkedActions,
        stored: instance.actions || null,
        overrides: instance.actions?.overrides || {}
      })
    });

  const applyError = err => {
    const data = err?.response?.data;
    if (Array.isArray(data?.details?.issues) && data.code === 'INVALID_VALUES') {
      const errors = {};
      for (const d of data.details.issues) if (d?.key) errors[d.key] = d.message;
      setFieldErrors(errors);
    }
    const detail = detailText(err);
    const message = getAdminApiErrorMessage(err);
    setError(detail ? `${message} (${detail})` : message);
  };

  /**
   * Test the unsaved values. `extra.testInput` is what the definition's
   * `test.input` asks for (a people directory's sample search).
   */
  const runTest = async (values, extra = {}) => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const body = buildPayload(values, extra);
      if (extra.testInput && Object.keys(extra.testInput).length > 0) {
        body.testInput = extra.testInput;
      }
      setTestResult(await testInstalledIntegration(instance.id, body));
    } catch (err) {
      applyError(err);
    } finally {
      setTesting(false);
    }
  };

  // The save that is running: a second request (the bar's Save and Enter in a field) joins it
  // instead of sending the installation twice.
  const inflightRef = useRef(null);

  /**
   * Save the values (see `buildPayload` for `extra`); `onSaved` gets the stored installation and
   * is awaited, so the page has reloaded when this resolves.
   *
   * @returns {Promise<boolean>} whether the installation was stored
   */
  const save = (values, extra = {}) => {
    if (inflightRef.current) return inflightRef.current;
    const run = (async () => {
      setSaving(true);
      setError(null);
      setFieldErrors({});
      try {
        const saved = await updateInstalledIntegration(instance.id, buildPayload(values, extra));
        await onSaved?.(saved);
        return true;
      } catch (err) {
        applyError(err);
        return false;
      } finally {
        setSaving(false);
        inflightRef.current = null;
      }
    })();
    inflightRef.current = run;
    return run;
  };

  /**
   * A check of the editor's own failed: show it like a server error on that field.
   *
   * @returns {false} so a `save` can `return editor.reject(…)`
   */
  const reject = (key, message) => {
    setFieldErrors(key ? { [key]: message } : {});
    setError(message);
    return false;
  };

  return {
    lang,
    grantedTo,
    label,
    setLabel,
    description,
    setDescription,
    knownActions,
    checkedActions,
    toggleAction,
    testing,
    testResult,
    saving,
    error,
    fieldErrors,
    runTest,
    save,
    reject
  };
}

/**
 * Reports whether a dedicated installation editor holds unsaved edits to the
 * page (through `DirtyReportContext`), so the page can guard against leaving
 * with them. The baseline is what the editor showed on its first render: every
 * editor builds its form synchronously from the stored installation, and the
 * page remounts the editor after a save, so that is the stored value.
 *
 * @param {ReturnType<typeof useInstallationEditor>} editor - the editor state
 * @param {*} edited - the editor's own form state (whatever it later saves from)
 * @returns {boolean} whether the editor is dirty
 *
 * @example
 * const editor = useInstallationEditor({ instance, definition, onSaved });
 * const [values, setValues] = useState(() => toForm(instance.values));
 * useInstallationEditorDirty(editor, values);
 */
export function useInstallationEditorDirty(editor, edited) {
  const report = use(DirtyReportContext);
  const current = useMemo(
    () => ({
      edited,
      label: editor.label,
      description: editor.description,
      // A Set has no own keys, so compare the checked actions as a sorted list.
      actions: [...(editor.checkedActions || [])].sort((a, b) => String(a).localeCompare(String(b)))
    }),
    [edited, editor.label, editor.description, editor.checkedActions]
  );
  const [baseline] = useState(current);
  return useDirtyReport(baseline, current, report);
}

/**
 * Hands the editor's save to the page that hosts it, so the page's save bar saves the editor
 * (and its Save and Cancel buttons are left out, see `EditorFooter`). Call it with the same
 * function the form's `onSubmit` runs: it checks the values, then saves, and resolves whether the
 * installation was stored.
 *
 * Without a host the editor is not managed and keeps its own buttons.
 *
 * @param {ReturnType<typeof useInstallationEditor>} editor - the editor state
 * @param {() => Promise<boolean>} save - validate and save the form
 * @returns {{ managed: boolean }}
 *
 * @example
 * const save = async () => {
 *   const problem = validate(values);
 *   if (problem) return editor.reject(problem.key, problem.message);
 *   return editor.save(values);
 * };
 * useInstallationEditorSave(editor, save);
 * const submit = event => {
 *   event.preventDefault();
 *   void save();
 * };
 */
export function useInstallationEditorSave(editor, save) {
  const host = use(EditorSaveContext);
  const error = editor.error;

  // The newest save on every render, so the bar never runs a stale form.
  useEffect(() => {
    if (host) host.saveRef.current = save;
  });
  // An editor that goes away (a remount after a save or a discard) has nothing left to save.
  useEffect(() => {
    if (!host) return undefined;
    return () => {
      host.saveRef.current = null;
    };
  }, [host]);

  useEffect(() => {
    host?.setError(error || null);
  }, [host, error]);
  useEffect(() => {
    if (!host) return undefined;
    return () => host.setError(null);
  }, [host]);

  return { managed: Boolean(host) };
}
