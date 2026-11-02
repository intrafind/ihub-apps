// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createElement } from 'react';
import IFinderEditor from './IFinderEditor';
import IAssistantEditor from './IAssistantEditor';
import PeopleDirectoryEditor from './PeopleDirectoryEditor';
import LdapBrowserEditor from './LdapBrowserEditor';
import EntraDirectoryEditor from './EntraDirectoryEditor';

/**
 * Dedicated installation editors, keyed by definition id.
 *
 * The **Settings** tab of an installation's page
 * (`/admin/integrations/:instanceId`, `AdminInstallationPage`) renders the
 * editor registered for the installation's definition, and the generic
 * `IntegrationInstallForm` (built from the definition's install fields) for
 * every definition without one. Installing a new installation always uses
 * the generic form (`IntegrationInstallDialog`).
 *
 * ## Contract
 *
 * An editor is a React component with these props:
 *
 * | Prop         | Type                      | Meaning |
 * | ------------ | ------------------------- | ------- |
 * | `instance`   | `Object`                  | The installation as `GET /api/admin/integrations/installed/:id` returns it in `instance` (`id`, `definition`, `labelLocalized`, `description`, `enabled`, `auth`, `actions`, …), with `values` replaced by the **effective** values (`values` of the response: defaults applied, sensitive fields left out) and `liveActions` set to the response's `actions` (what the system lists now, for MCP / A2A). |
 * | `definition` | `Object`                  | The definition detail (`definition` of the same response): `install` fields, `actions`, `authModes`, `dynamicActions`, `name`, … |
 * | `onSaved`    | `(saved: Object) => void` | Called with the stored installation after a successful `PUT …/installed/:id`. |
 * | `onCancel`   | `() => void`              | The admin discards the edits. |
 *
 * An editor owns its install values and nothing else: `useInstallationEditor`
 * keeps the label, description, groups and action switches, tests the unsaved
 * values (`POST …/installed/:id/_test`) and saves (`PUT …/installed/:id`,
 * body built by `buildInstallationPayload`, which sends back every part the
 * editor did not change). `InstallationEditorParts` has the shared sections
 * (name, who may use it, actions, footer).
 *
 * ## Adding an editor
 *
 * 1. Write `editors/<Name>Editor.jsx` with the props above, built from
 *    `useInstallationEditor` and `InstallationEditorParts`.
 * 2. Register it below under its definition id.
 * 3. Add its strings under `admin.integrations.editors.<name>.*` in
 *    `shared/i18n/en.json` and `de.json`.
 *
 * @module features/admin/components/integrations/editors
 */
const EDITORS = Object.freeze({
  'com.intrafind/ifinder': IFinderEditor,
  'com.intrafind/iassistant': IAssistantEditor,
  'com.intrafind/ldap-directory': PeopleDirectoryEditor,
  'com.intrafind/ldap-browser': LdapBrowserEditor,
  'com.intrafind/entra-directory': EntraDirectoryEditor
});

/**
 * The dedicated editor of a definition, or null when the generic form edits it.
 *
 * @param {string|null|undefined} definitionId - e.g. `com.intrafind/ifinder`
 * @returns {React.ComponentType<{ instance: Object, definition: Object, onSaved: Function, onCancel: Function }>|null}
 */
export function getInstallationEditor(definitionId) {
  if (!definitionId || !Object.hasOwn(EDITORS, definitionId)) return null;
  return EDITORS[definitionId];
}

/**
 * Whether a definition has a dedicated editor.
 *
 * @param {string|null|undefined} definitionId
 * @returns {boolean}
 */
export function hasDedicatedEditor(definitionId) {
  return getInstallationEditor(definitionId) !== null;
}

/**
 * The dedicated editor of `definitionId` with the contract props, or nothing
 * when the definition has none (the caller renders the generic form then).
 *
 * @param {Object} props
 * @param {string} props.definitionId
 * @param {Object} props.instance
 * @param {Object} props.definition
 * @param {(saved: Object) => void} props.onSaved
 * @param {() => void} props.onCancel
 * @returns {React.ReactElement|null}
 */
export function InstallationEditor({ definitionId, ...props }) {
  const editor = getInstallationEditor(definitionId);
  return editor ? createElement(editor, props) : null;
}

/**
 * The `instance` prop of an editor from a `GET …/installed/:id` response.
 *
 * @param {{ instance: Object, values?: Object, actions?: Object[] }} detail
 * @returns {Object}
 */
export function editorInstance(detail) {
  return {
    ...detail.instance,
    values: detail.values || {},
    liveActions: detail.actions || []
  };
}
