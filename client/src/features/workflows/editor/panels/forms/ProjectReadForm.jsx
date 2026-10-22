// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import FormField from './FormField';
import ProjectRefField from './ProjectRefField';
import {
  PROJECT_NODE_DEFAULT_OUTPUT,
  referenceSuggestions,
  withProjectValue
} from '../../../utils/projectNodeConfig';

/** The usual document reference inside a `forEach` loop over a `project-items` list. */
const LOOP_ITEM_DOCUMENT = '$.data._loopItem.id';

/**
 * Config form for `project-read` steps (#1036, slice 6): one document's text
 * from a project into workflow state, without a tool call.
 *
 * Offers the project (picked or referenced), the document (an item id or a
 * `$.data…` reference, by default the current loop item), an optional
 * section, a character budget and the output variable. The step writes
 * `{ project, document, name, text, chars, retrieval, doc }`, so a later
 * prompt reads the text as `{{<outputVariable>.text}}`.
 *
 * @param {Object} props
 * @param {Object} props.config - The step config.
 * @param {(config: Object) => void} props.onChange
 * @param {Array<{value: string, label: string}>} [props.variables] - Variables visible to the step.
 * @returns {JSX.Element}
 */
function ProjectReadForm({ config, onChange, variables }) {
  const { t } = useTranslation();
  const outputName = PROJECT_NODE_DEFAULT_OUTPUT['project-read'];
  const documentSuggestions = [
    {
      value: LOOP_ITEM_DOCUMENT,
      label: t('workflows.editor.projectNodes.read.loopItem', 'Current loop item')
    },
    ...referenceSuggestions(variables)
  ];

  return (
    <div className="space-y-3">
      <ProjectRefField
        value={config.project}
        onChange={(v, options) => onChange(withProjectValue(config, v, options))}
        variables={variables}
      />
      <FormField
        label={t('workflows.editor.projectNodes.read.document', 'Document')}
        value={config.document}
        onChange={v => onChange({ ...config, document: v })}
        placeholder={LOOP_ITEM_DOCUMENT}
        suggestions={documentSuggestions}
        helpText={t(
          'workflows.editor.projectNodes.read.documentHelp',
          'The item id, or a $.data reference to one. Inside a loop over a document list: {{reference}}',
          { reference: LOOP_ITEM_DOCUMENT }
        )}
      />
      <FormField
        label={t('workflows.editor.projectNodes.read.section', 'Section')}
        value={config.section}
        onChange={v => onChange({ ...config, section: v || undefined })}
        helpText={t(
          'workflows.editor.projectNodes.read.sectionHelp',
          'Optional. A heading or section id to read instead of the whole document.'
        )}
      />
      <FormField
        label={t('workflows.editor.projectNodes.read.maxChars', 'Max characters')}
        type="number"
        value={config.maxChars}
        onChange={v => onChange({ ...config, maxChars: v > 0 ? v : undefined })}
        min={1}
        step={1000}
        helpText={t(
          'workflows.editor.projectNodes.read.maxCharsHelp',
          'Optional budget for the text. Empty: the server default.'
        )}
      />
      <FormField
        label={t('workflows.editor.projectNodes.outputVariable', 'Output variable')}
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder={outputName}
        suggestions={variables}
        helpText={t(
          'workflows.editor.projectNodes.read.outputHelp',
          'State variable for the document. Default: {{name}}. Its text is {{name}}.text, its name {{name}}.name.',
          { name: outputName }
        )}
      />
    </div>
  );
}

export default ProjectReadForm;
