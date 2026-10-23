// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How an OAuth client record was provisioned — shown as a badge and used for
 * the kind filter. This says nothing about the permissions of the people who
 * connect through the client; those come from the RBAC groups of the user.
 *
 * `dynamic` records come from RFC 7591 registration and are the ones that
 * arrive in bulk — one per piece of MCP client software since de-duplication,
 * one per user before it — so the list hides them by default. `cimd` records
 * belong to clients identified by a metadata document. `static` is everything
 * an admin configured on the platform.
 */
export function clientKind(client) {
  if (client?.metadata?.dcr === true) return 'dynamic';
  if (client?.personal === true) return 'personal';
  if (client?.metadata?.cimd === true) return 'cimd';
  return 'static';
}

export const KIND_BADGE_CLASSES = {
  static: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  personal: 'bg-teal-100 dark:bg-teal-900/50 text-teal-800 dark:text-teal-300',
  dynamic: 'bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300',
  cimd: 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300'
};

export const KIND_DEFAULT_LABELS = {
  static: 'Static',
  personal: 'Personal',
  dynamic: 'Dynamic',
  cimd: 'Client metadata'
};

export const KIND_DEFAULT_HELP = {
  static:
    'Configured by an administrator in the platform. Describes how the client was provisioned, not the permissions of the people who connect through it.',
  personal:
    'Created by a user for their own use. Describes how the client was provisioned, not the permissions of the people who connect through it.',
  dynamic:
    'Registered automatically by an MCP client through dynamic client registration. Describes how the client was provisioned, not the permissions of the people who connect through it.',
  cimd: 'Identified by a client metadata document that the client publishes at its client ID URL. Describes how the client was provisioned, not the permissions of the people who connect through it.'
};
