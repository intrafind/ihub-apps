// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../../shared/components/Modal';
import Icon from '../../../../shared/components/Icon';
import IntegrationInstallForm from './IntegrationInstallForm';

/**
 * Install (or edit) an installation of a definition in a modal: the header
 * with the definition's name and version around the generic
 * `IntegrationInstallForm`. Admin → Integrations opens it from the Catalog
 * tab and from the `?install=<folder>` deep link; an existing installation is
 * edited on its own page instead (`/admin/integrations/:instanceId`).
 *
 * @param {Object} props
 * @param {string} props.definitionId - definition to install
 * @param {string} [props.instanceId] - edit this instance instead of creating one
 * @param {string[]} [props.takenIds] - existing instance ids (to propose a free one)
 * @param {{ values?: Object, label?: string }} [props.prefill] - install values and
 *   label to start a new installation with (a deep link from another page)
 * @param {() => void} props.onClose
 * @param {(instance: Object) => void} props.onSaved
 */
function IntegrationInstallDialog({
  definitionId,
  instanceId,
  takenIds,
  prefill,
  onClose,
  onSaved
}) {
  const { t } = useTranslation();
  const [definition, setDefinition] = useState(null);
  const title = instanceId
    ? t('admin.integrationCatalog.wizard.editTitle', 'Edit integration')
    : t('admin.integrationCatalog.wizard.installTitle', 'Install integration');

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-3xl"
      labelledBy="integration-install-title"
    >
      <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
        <div>
          <h2
            id="integration-install-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {title}
          </h2>
          {definition && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
              {definition.name}
              <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                {definition.id} · v{definition.version}
              </span>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label={t('common.close', 'Close')}
        >
          <Icon name="x" size="md" />
        </button>
      </div>
      <IntegrationInstallForm
        variant="dialog"
        definitionId={definitionId}
        instanceId={instanceId}
        takenIds={takenIds}
        prefill={prefill}
        onLoaded={setDefinition}
        onCancel={onClose}
        onSaved={onSaved}
      />
    </Modal>
  );
}

export default IntegrationInstallDialog;
