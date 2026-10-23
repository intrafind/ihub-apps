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
    <li className="flex items-center gap-2 py-1.5 text-sm">
      <Icon
        name={TARGET_ICONS[member.type] || 'user'}
        size="sm"
        className="text-gray-500 flex-none"
      />
      <span className="flex-1 min-w-0 truncate text-gray-900 dark:text-gray-100">{name}</span>
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
    <section
      className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5"
      aria-labelledby="project-members-title"
    >
      <h2
        id="project-members-title"
        className="text-base font-semibold text-gray-900 dark:text-gray-100"
      >
        {t('projects.members.title', 'Members')}
      </h2>
      <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2">
        <Icon name="user" size="sm" className="text-gray-500" />
        <span className="truncate">
          {project.owner?.name || t('projects.members.unknownOwner', 'Unknown')}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {t('projects.roles.owner', 'Owner')}
          {project.owner?.active === false && ` · ${t('projects.members.inactive', 'inactive')}`}
        </span>
      </p>
      {members ? (
        members.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
            <Icon name="lock" size="sm" />
            {t('projects.members.private', 'Only the owner — this project is private.')}
          </p>
        ) : (
          <ul className="mt-1 max-h-72 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
            {members.map(member => (
              <MemberRow key={`${member.type}:${member.id ?? ''}`} member={member} />
            ))}
          </ul>
        )
      ) : (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          {t('projects.members.count', '{{count}} members', { count: memberCountOf(project) })}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {permissions.canShare && (
          <button
            type="button"
            onClick={() => setSharing(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            <Icon name="share" size="sm" />
            {t('projects.members.manage', 'Share')}
          </button>
        )}
        {permissions.canTransfer && permissions.isOwner && (
          <button
            type="button"
            onClick={() => setTransferring(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            <Icon name="arrows-right-left" size="sm" />
            {t('projects.members.transfer', 'Transfer ownership')}
          </button>
        )}
        {canLeave && (
          <button
            type="button"
            onClick={() => setLeaving(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30"
          >
            <Icon name="logout" size="sm" />
            {t('projects.members.leave', 'Leave project')}
          </button>
        )}
      </div>

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
    </section>
  );
}

export default ProjectMembersSection;
