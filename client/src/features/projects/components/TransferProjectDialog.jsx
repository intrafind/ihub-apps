// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import TransferOwnerDialog from '../../../shared/components/TransferOwnerDialog';
import { fetchProjectShareTargets, transferProject } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import { projectDisplayName } from '../utils/projectView';

/** The project call behind the dialog: the new owner gets the project at once. */
const transfer = (project, newOwner) => transferProject(project.id, newOwner.id);

/**
 * Hands a project to another user (`POST …/transfer`, owner only). The new
 * owner gets everything; the previous owner keeps no role unless the new
 * owner adds them.
 *
 * The two steps (pick the new owner, then confirm after reading what the
 * hand-over means) are those of the shared `TransferOwnerDialog`; this file
 * passes the project calls and the project texts. Nothing is sent before the
 * confirmation.
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {() => void} props.onClose
 * @param {(result: Object, newOwner: {id: string, name: string}) => void} props.onTransferred -
 *   The project, or `{ id, transferred: true }` when the caller can no longer
 *   see it, and the user it now belongs to.
 * @returns {JSX.Element}
 */
function TransferProjectDialog({ project, onClose, onTransferred }) {
  const { t, i18n } = useTranslation();
  // Shares that may still reach the caller after the hand-over. Only the
  // ownership moves, so these stay in force, the catalog included.
  const wideShares = [
    ...(Array.isArray(project.members) ? project.members : [])
      .filter(member => member.type === 'group' || member.type === 'everyone')
      .map(member =>
        member.type === 'everyone'
          ? t('projects.transfer.everyone', 'everyone signed in')
          : member.name || member.id
      ),
    ...(project.audience?.catalog ? [t('projects.transfer.catalog', 'the project catalog')] : [])
  ];

  const labels = {
    title: t('projects.transfer.title', 'Transfer ownership'),
    hint: t(
      'projects.transfer.hint',
      'Choose who takes the project over. You confirm in the next step.'
    ),
    search: t('projects.transfer.search', 'Search people'),
    submit: t('projects.transfer.submit', 'Transfer'),
    submitTo: newOwner =>
      t('projects.transfer.submitTo', 'Transfer to {{name}}', { name: newOwner.name }),
    confirmTitle: newOwner =>
      t('projects.transfer.confirmTitle', 'Transfer “{{project}}” to {{name}}?', {
        project: projectDisplayName(project, i18n.language),
        name: newOwner.name
      }),
    confirmIntro: t('projects.transfer.confirmIntro', 'This is what the transfer means:'),
    lines: newOwner => [
      t(
        'projects.transfer.confirmNewOwner',
        '{{name}} becomes the owner and may change, share and delete the project.',
        { name: newOwner.name }
      ),
      t(
        'projects.transfer.confirmYou',
        'You are no longer the owner: you can no longer delete the project or transfer it.'
      ),
      wideShares.length > 0
        ? t(
            'projects.transfer.confirmKeepsShares',
            'It stays shared with {{audiences}}. If you belong to one of them, you keep that access.',
            { audiences: wideShares.join(', ') }
          )
        : t(
            'projects.transfer.confirmAccess',
            'You lose access to the project unless {{name}} shares it with you again.',
            { name: newOwner.name }
          ),
      t(
        'projects.transfer.confirmContent',
        'Documents, instructions, members and chats stay with the project.'
      )
    ],
    footnote: t('projects.transfer.confirmUndo', 'Only the new owner can transfer it back.'),
    confirm: () => t('projects.transfer.confirm', 'Yes, transfer ownership'),
    sending: t('projects.transfer.transferring', 'Transferring…'),
    back: t('common.back', 'Back'),
    cancel: t('common.cancel', 'Cancel')
  };

  return (
    <TransferOwnerDialog
      item={project}
      fetchTargets={fetchProjectShareTargets}
      transfer={transfer}
      errorMessage={projectErrorMessage}
      labels={labels}
      titleId="transfer-project-title"
      onClose={onClose}
      onTransferred={onTransferred}
    />
  );
}

export default TransferProjectDialog;
