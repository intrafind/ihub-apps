// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import FormField from './FormField';
import ProjectRefField from './ProjectRefField';
import {
  PROJECT_NODE_DEFAULT_OUTPUT,
  PROJECT_WRITE_CONTENT_TYPES,
  referenceSuggestions
} from '../../../utils/projectNodeConfig';

/** Content type the server stores when the step names none. */
const DEFAULT_CONTENT_TYPE = PROJECT_WRITE_CONTENT_TYPES[0];

/*
 * Template syntax shown in help texts. Passed as interpolation values: written
 * into a translation, i18next would read the braces as its own placeholders.
 */
const TEMPLATE_HINT = '{{…}}';
const LOOP_ITEM_NAME = '{{item.name}}';

/**
 * Config form for `project-write` steps (#1036, slice 6): store a text the
 * run produced as a document of a project.
 *
 * Offers the project (picked or referenced), the document name and text
 * (both take `$.data…` references and `{{…}}` templates; `{{item.name}}` is
 * the current loop item), the content type, whether the document is pinned,
 * whether the run waits until it is ready, and the output variable.
 *
 * The write is allowed when the running user owns or edits a user project,
 * or when the workflow's link to an admin project carries `write: true`; the
 * help text says so, the check runs on the server.
 *
 * @param {Object} props
 * @param {Object} props.config - The step config.
 * @param {(config: Object) => void} props.onChange
 * @param {Array<{value: string, label: string}>} [props.variables] - Variables visible to the step.
 * @returns {JSX.Element}
 */
function ProjectWriteForm({ config, onChange, variables }) {
  const { t } = useTranslation();
  const outputName = PROJECT_NODE_DEFAULT_OUTPUT['project-write'];
  const references = referenceSuggestions(variables);

  return (
    <div className="space-y-3">
      <ProjectRefField
        value={config.project}
        onChange={v => onChange({ ...config, project: v })}
        variables={variables}
        helpText={t(
          'workflows.editor.projectNodes.write.permissionHelp',
          'The running user must own or edit a user project. An admin project needs a workflow project link with write access ("write": true in the JSON tab).'
        )}
      />
      <FormField
        label={t('workflows.editor.projectNodes.write.name', 'Document name')}
        value={config.name}
        onChange={v => onChange({ ...config, name: v })}
        placeholder={t(
          'workflows.editor.projectNodes.write.namePlaceholder',
          'Summary of {{example}}',
          {
            example: LOOP_ITEM_NAME
          }
        )}
        suggestions={references}
        helpText={t(
          'workflows.editor.projectNodes.write.nameHelp',
          'Text with {{template}} variables, or a $.data reference. Inside a loop, {{example}} is the current item.',
          { template: TEMPLATE_HINT, example: LOOP_ITEM_NAME }
        )}
      />
      <FormField
        label={t('workflows.editor.projectNodes.write.text', 'Text')}
        type="textarea"
        rows={4}
        value={config.text}
        onChange={v => onChange({ ...config, text: v })}
        placeholder="$.data.summary"
        helpText={t(
          'workflows.editor.projectNodes.write.textHelp',
          'Usually a $.data reference to an earlier step’s output; a text with {{template}} variables works too. Objects are stored as JSON.',
          { template: TEMPLATE_HINT }
        )}
      />
      <FormField
        label={t('workflows.editor.projectNodes.write.contentType', 'Content type')}
        value={config.contentType}
        onChange={v => onChange({ ...config, contentType: v || undefined })}
        placeholder={DEFAULT_CONTENT_TYPE}
        suggestions={[...PROJECT_WRITE_CONTENT_TYPES]}
        helpText={t('workflows.editor.projectNodes.write.contentTypeHelp', 'Default: {{type}}', {
          type: DEFAULT_CONTENT_TYPE
        })}
      />
      <FormField
        label={t('workflows.editor.projectNodes.write.pinned', 'Pin the document')}
        type="checkbox"
        value={config.pinned === true}
        onChange={v => onChange({ ...config, pinned: v })}
      />
      <FormField
        label={t('workflows.editor.projectNodes.write.wait', 'Wait until the document is ready')}
        type="checkbox"
        value={config.wait !== false}
        onChange={v => onChange({ ...config, wait: v })}
      />
      <FormField
        label={t('workflows.editor.projectNodes.outputVariable', 'Output variable')}
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder={outputName}
        suggestions={variables}
        helpText={t(
          'workflows.editor.projectNodes.write.outputHelp',
          'State variable for the stored document. Default: {{name}}. Keep "wait" on when a later step reads the document.',
          { name: outputName }
        )}
      />
    </div>
  );
}

export default ProjectWriteForm;
