// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pickText } from '../ConfigFieldInput';
import { buildActionsPolicy, initialCheckedActions } from '../actionsPolicy';
import { buildInstallationPayload } from '../installationPayload';
import {
  testInstalledIntegration,
  updateInstalledIntegration
} from '../../../../../api/integrationsAdminApi';
import { fetchAdminGroups, getAdminApiErrorMessage } from '../../../../../api/adminApi';

/** `GET /api/admin/groups` as `GroupMultiSelect` options. */
function groupOptions(groupsResult) {
  if (groupsResult?.groups) {
    return Object.entries(groupsResult.groups).map(([id, g]) => ({ id, name: g.name || id }));
  }
  return Array.isArray(groupsResult) ? groupsResult : [];
}

/** The server's validation details as one line, e.g. `baseUrl: must be a URL`. */
function detailText(err) {
  const details = err?.response?.data?.details;
  if (!Array.isArray(details)) return '';
  return details
    .map(d => (d?.key ? `${d.key}: ${d.message}` : d?.message))
    .filter(Boolean)
    .join('; ');
}

/**
 * The state every dedicated installation editor shares, so an editor only
 * owns its install values: the label and description (in the admin's
 * language, other languages kept), the groups, the action switches, the test
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

  const [groups, setGroups] = useState([]);
  const [label, setLabel] = useState(() => pickText(instance.labelLocalized, lang) || '');
  const [description, setDescription] = useState(() => pickText(instance.description, lang) || '');
  const [allowedGroups, setAllowedGroups] = useState(() => instance.allowedGroups || []);
  const [{ knownActions, checked: initialChecked }] = useState(() =>
    initialCheckedActions({ definition, instance, liveActions: instance.liveActions || [] })
  );
  const [checkedActions, setCheckedActions] = useState(initialChecked);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    let cancelled = false;
    fetchAdminGroups()
      .then(result => {
        if (!cancelled) setGroups(groupOptions(result));
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleAction = (name, on) =>
    setCheckedActions(prev => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  /** The PUT / test body with these install values and everything else from the editor. */
  const buildPayload = values =>
    buildInstallationPayload(instance, {
      values,
      lang,
      label,
      description,
      allowedGroups,
      actions: buildActionsPolicy({
        knownActions,
        checkedActions,
        stored: instance.actions || null,
        overrides: instance.actions?.overrides || {}
      })
    });

  const applyError = err => {
    const data = err?.response?.data;
    if (Array.isArray(data?.details) && data.code === 'INVALID_VALUES') {
      const errors = {};
      for (const d of data.details) if (d?.key) errors[d.key] = d.message;
      setFieldErrors(errors);
    }
    const detail = detailText(err);
    const message = getAdminApiErrorMessage(err);
    setError(detail ? `${message} (${detail})` : message);
  };

  /** Test the unsaved values. */
  const runTest = async values => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await testInstalledIntegration(instance.id, buildPayload(values)));
    } catch (err) {
      applyError(err);
    } finally {
      setTesting(false);
    }
  };

  /** Save the values; `onSaved` gets the stored installation. */
  const save = async values => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const saved = await updateInstalledIntegration(instance.id, buildPayload(values));
      onSaved?.(saved);
    } catch (err) {
      applyError(err);
    } finally {
      setSaving(false);
    }
  };

  /** A check of the editor's own failed: show it like a server error on that field. */
  const reject = (key, message) => {
    setFieldErrors(key ? { [key]: message } : {});
    setError(message);
  };

  return {
    lang,
    groups,
    label,
    setLabel,
    description,
    setDescription,
    allowedGroups,
    setAllowedGroups,
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
