// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import FormField from './FormField';
import CheckboxGroupField from './CheckboxGroupField';
import ProjectRefField from './ProjectRefField';
import { useProjectKindOptions } from './useProjectNodeOptions';
import { localizedText } from '../../../../projects/utils/projectItems';
import {
  MAX_PROJECT_ITEMS,
  PINNED_CHOICES,
  PROJECT_ITEM_ORIGINS,
  PROJECT_ITEM_STATUSES,
  PROJECT_NODE_DEFAULT_OUTPUT,
  effectiveStatuses,
  pinnedChoice,
  toggleListValue,
  withListFilter,
  withPinnedChoice,
  withStatuses
} from '../../../utils/projectNodeConfig';

/** Status labels: the ones the project pages already show. */
const STATUS_LABEL_KEYS = {
  ready: ['projects.items.status.ready', 'Ready'],
  stale: ['projects.items.status.stale', 'Outdated'],
  pending: ['projects.items.status.pending', 'Waiting'],
  extracting: ['projects.items.status.extracting', 'Extracting'],
  failed: ['projects.items.status.failed', 'Failed']
};

/** Origin labels (`provenance.origin`). */
const ORIGIN_LABEL_KEYS = {
  uploaded: ['workflows.editor.projectNodes.origins.uploaded', 'Uploaded'],
  written: ['workflows.editor.projectNodes.origins.written', 'Written by a run'],
  picked: ['workflows.editor.projectNodes.origins.picked', 'Picked from a source'],
  linked: ['workflows.editor.projectNodes.origins.linked', 'Linked'],
  migrated: ['workflows.editor.projectNodes.origins.migrated', 'Migrated']
};

/** Labels of the tri-state pinned filter. */
const PINNED_LABEL_KEYS = {
  any: ['workflows.editor.projectNodes.items.pinned.any', 'Any'],
  pinned: ['workflows.editor.projectNodes.items.pinned.pinned', 'Pinned only'],
  unpinned: ['workflows.editor.projectNodes.items.pinned.unpinned', 'Not pinned']
};

/**
 * Config form for `project-items` steps (#1036, slice 6): the documents of a
 * project as a list in workflow state, usually iterated by a `forEach` loop
 * whose body reads each with a `project-read` step (`$.data._loopItem.id`).
 *
 * Offers the project (picked or referenced), a filter by item kind, status,
 * pinned state and origin, the limit, and the output variable. The filter's
 * empty selections follow the server: no kind or origin ticked means any;
 * the status defaults to ready and outdated.
 *
 * @param {Object} props
 * @param {Object} props.config - The step config.
 * @param {(config: Object) => void} props.onChange
 * @param {Array<{value: string, label: string}>} [props.variables] - Variables visible to the step.
 * @returns {JSX.Element}
 */
function ProjectItemsForm({ config, onChange, variables }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const { kinds } = useProjectKindOptions();
  const filter = config.filter || {};
  const selectedKinds = Array.isArray(filter.kinds) ? filter.kinds : [];
  const selectedOrigins = Array.isArray(filter.origin) ? filter.origin : [];
  const statuses = effectiveStatuses(filter);

  // Disabled kinds are offered only when the filter already names them.
  const kindOptions = kinds
    .filter(kind => kind.enabled !== false || selectedKinds.includes(kind.id))
    .map(kind => ({ value: kind.id, label: localizedText(kind.name, language) || kind.id }));
  const kindOrder = kindOptions.map(option => option.value);

  const statusOptions = PROJECT_ITEM_STATUSES.map(status => ({
    value: status,
    label: t(...STATUS_LABEL_KEYS[status])
  }));
  const originOptions = PROJECT_ITEM_ORIGINS.map(origin => ({
    value: origin,
    label: t(...ORIGIN_LABEL_KEYS[origin])
  }));
  const pinnedOptions = PINNED_CHOICES.map(choice => ({
    value: choice,
    label: t(...PINNED_LABEL_KEYS[choice])
  }));

  return (
    <div className="space-y-3">
      <ProjectRefField
        value={config.project}
        onChange={v => onChange({ ...config, project: v })}
        variables={variables}
      />
      <CheckboxGroupField
        label={t('workflows.editor.projectNodes.items.kinds', 'Item kinds')}
        options={kindOptions}
        value={selectedKinds}
        onToggle={kind =>
          onChange(withListFilter(config, 'kinds', toggleListValue(selectedKinds, kind, kindOrder)))
        }
        helpText={t(
          'workflows.editor.projectNodes.items.kindsHelp',
          'Only documents of these kinds. None ticked: every kind.'
        )}
      />
      <CheckboxGroupField
        label={t('workflows.editor.projectNodes.items.status', 'Status')}
        options={statusOptions}
        value={statuses}
        onToggle={status =>
          onChange(
            withStatuses(config, toggleListValue(statuses, status, [...PROJECT_ITEM_STATUSES]))
          )
        }
        helpText={t(
          'workflows.editor.projectNodes.items.statusHelp',
          'Default: ready and outdated, the documents whose text can be read. None ticked: every status.'
        )}
      />
      <FormField
        label={t('workflows.editor.projectNodes.items.pinnedLabel', 'Pinned')}
        type="select"
        value={pinnedChoice(filter)}
        options={pinnedOptions}
        onChange={choice => onChange(withPinnedChoice(config, choice))}
      />
      <CheckboxGroupField
        label={t('workflows.editor.projectNodes.items.origin', 'Origin')}
        options={originOptions}
        value={selectedOrigins}
        onToggle={origin =>
          onChange(
            withListFilter(
              config,
              'origin',
              toggleListValue(selectedOrigins, origin, [...PROJECT_ITEM_ORIGINS])
            )
          )
        }
        helpText={t(
          'workflows.editor.projectNodes.items.originHelp',
          'Where the document came from. None ticked: any origin.'
        )}
      />
      <FormField
        label={t('workflows.editor.projectNodes.items.limit', 'Max documents')}
        type="number"
        value={config.limit}
        onChange={v => onChange({ ...config, limit: v > 0 ? v : undefined })}
        min={1}
        max={MAX_PROJECT_ITEMS}
        helpText={t(
          'workflows.editor.projectNodes.items.limitHelp',
          'At most this many documents. Default and maximum: {{max}}',
          { max: MAX_PROJECT_ITEMS }
        )}
      />
      <FormField
        label={t('workflows.editor.projectNodes.outputVariable', 'Output variable')}
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder={PROJECT_NODE_DEFAULT_OUTPUT['project-items']}
        suggestions={variables}
        helpText={t(
          'workflows.editor.projectNodes.items.outputHelp',
          'State variable for the list of documents. Default: {{name}}. Loop over it with a Repeat step (for each item); each round reads $.data._loopItem.id.',
          { name: PROJECT_NODE_DEFAULT_OUTPUT['project-items'] }
        )}
      />
    </div>
  );
}

export default ProjectItemsForm;
