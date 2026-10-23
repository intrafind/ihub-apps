// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import PromptShareDialog from '../../prompts/components/PromptShareDialog';
import { fetchProjectShareTargets, updateProjectMembers } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import {
  memberCountOf,
  membersToShares,
  membersWithout,
  ownMemberEntry,
  sharesToMembers
} from '../utils/projectView';
import ProjectPanelRow, { ROW_ACTION } from './ProjectPanelRow';
import TransferProjectDialog from './TransferProjectDialog';

const TARGET_ICONS = { user: 'user', group: 'user-group', everyone: 'globe' };

/** Saves the share dialog's list as the project's members. */
const saveMembers = (projectId, shares) => updateProjectMembers(projectId, sharesToMembers(shares));

/** Share-target lookup for the share dialog. */
const loadTargets = query => fetchProjectShareTargets(query);

/**
 * One member row.
 *
 * @param {{member: Object}} props
 * @returns {JSX.Element}
 */
function MemberRow({ member }) {
  const { t } = useTranslation();
  const name =
    member.type === 'everyone'
      ? t('projects.members.everyone', 'Everyone signed in')
      : member.name || member.id;
  return (
    <li className="flex items-center gap-2 py-1">
      <Icon
        name={TARGET_ICONS[member.type] || 'user'}
        size="xs"
        className="text-gray-400 flex-none"
      />
      <span className="flex-1 min-w-0 truncate text-gray-700 dark:text-gray-300">{name}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {member.role === 'editor'
          ? t('projects.roles.editor', 'Editor')
          : t('projects.roles.user', 'User')}
      </span>
    </li>
  );
}

/**
 * Who a project belongs to and who it is shared with (spec 1 §2, §5.1): the
 * owner, the members with their role, and — as the permissions allow —
 * changing members (users, groups, everyone; roles *user* and *editor*),
 * transferring ownership, and leaving.
 *
 * Leaving is offered to a member listed by name who may change members (an
 * editor): the API has no separate "leave" call, so leaving writes the
 * member list without the caller. A *user* or a member through a group
 * cannot leave on their own (see the slice 5 hand-over note).
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {string|null} props.userId - The viewer.
 * @param {(project: Object) => void} props.onChanged - The project after a member change.
 * @param {(result: Object, newOwner: Object) => void} props.onTransferred
 * @param {() => void} props.onLeft
 * @returns {JSX.Element}
 */
function ProjectMembersSection({ project, userId, onChanged, onTransferred, onLeft }) {
  const { t } = useTranslation();
  const [sharing, setSharing] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState(null);
  const permissions = project.permissions || {};
  const members = Array.isArray(project.members) ? project.members : null;
  const canLeave =
    !permissions.isOwner && permissions.canShare && Boolean(ownMemberEntry(project, userId));

  const leave = async () => {
    setLeaving(false);
    setError(null);
    try {
      await updateProjectMembers(project.id, membersWithout(project, userId));
      onLeft();
    } catch (err) {
      setError(projectErrorMessage(err, t));
    }
  };

  return (
    <>
      <ProjectPanelRow
        icon="user-group"
        title={t('projects.members.title', 'Members')}
        titleId="project-members-title"
        action={
          permissions.canShare ? (
            <button type="button" onClick={() => setSharing(true)} className={ROW_ACTION}>
              {t('projects.members.manage', 'Share')}
            </button>
          ) : null
        }
      >
        <p className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
          <span className="truncate">
            {project.owner?.name || t('projects.members.unknownOwner', 'Unknown')}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400 flex-none">
            {t('projects.roles.owner', 'Owner')}
            {project.owner?.active === false && ` · ${t('projects.members.inactive', 'inactive')}`}
          </span>
        </p>
        {members ? (
          members.length === 0 ? (
            <p className="mt-1 text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
              <Icon name="lock" size="xs" />
              {t('projects.members.private', 'Only the owner — this project is private.')}
            </p>
          ) : (
            <ul className="mt-0.5 max-h-48 overflow-y-auto">
              {members.map(member => (
                <MemberRow key={`${member.type}:${member.id ?? ''}`} member={member} />
              ))}
            </ul>
          )
        ) : (
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            {t('projects.members.count', '{{count}} members', { count: memberCountOf(project) })}
          </p>
        )}

        {error && (
          <p role="alert" className="mt-2 text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {((permissions.canTransfer && permissions.isOwner) || canLeave) && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {permissions.canTransfer && permissions.isOwner && (
              <button
                type="button"
                onClick={() => setTransferring(true)}
                className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
              >
                <Icon name="arrows-right-left" size="xs" />
                {t('projects.members.transfer', 'Transfer ownership')}
              </button>
            )}
            {canLeave && (
              <button
                type="button"
                onClick={() => setLeaving(true)}
                className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
              >
                <Icon name="logout" size="xs" />
                {t('projects.members.leave', 'Leave project')}
              </button>
            )}
          </div>
        )}
      </ProjectPanelRow>

      {sharing && (
        <PromptShareDialog
          prompt={{ id: project.id, name: project.name, shares: membersToShares(members || []) }}
          onClose={() => setSharing(false)}
          onSaved={saved => {
            setSharing(false);
            onChanged(saved);
          }}
          fetchTargets={loadTargets}
          saveShares={saveMembers}
          errorMessage={projectErrorMessage}
          labels={{
            title: t('projects.members.shareTitle', 'Share project'),
            private: t('projects.members.private', 'Only the owner — this project is private.'),
            help: t(
              'projects.members.shareHelp',
              '“Can use” makes someone a user: they chat with the project and read its documents. “Can edit” makes them an editor: they also add and remove documents, edit the instructions and change members.'
            )
          }}
        />
      )}
      {transferring && (
        <TransferProjectDialog
          project={project}
          onClose={() => setTransferring(false)}
          onTransferred={(result, newOwner) => {
            setTransferring(false);
            onTransferred(result, newOwner);
          }}
        />
      )}
      <ConfirmDialog
        isOpen={leaving}
        title={t('projects.members.leaveTitle', 'Leave project')}
        message={t(
          'projects.members.leaveConfirm',
          'You lose access to this project and its chats unless someone shares it with you again.'
        )}
        confirmLabel={t('projects.members.leave', 'Leave project')}
        danger
        onConfirm={leave}
        onDeny={() => setLeaving(false)}
      />
    </>
  );
}

export default ProjectMembersSection;
