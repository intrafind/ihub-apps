// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Constants of the project model shared by the validators and the access
 * policy. Dependency-free on purpose: the validators are imported by the app
 * schema, which the config cache loads, which the authorization layer reads
 * — a constant that lived beside the policy would close that cycle.
 *
 * @module services/projects/projectConstants
 */

/**
 * The most characters one item keeps (about 10 MB of text, 2.5 million tokens).
 * The BM25 search indexes a text this long in about two seconds, once, and
 * answers from the index in milliseconds. Longer text is cut, and the item is
 * marked `truncated`.
 */
export const MAX_ITEM_TEXT_CHARS = 10_000_000;

/** Most projects a chat may have attached besides its own container. */
export const MAX_ATTACHED_PROJECTS = 10;

/** Member target types. */
export const MEMBER_TARGET_TYPES = Object.freeze(['user', 'group', 'everyone']);

/** The roles a member can hold; the owner is not a member. */
export const MEMBER_ROLES = Object.freeze(['editor', 'user']);

/** Access levels a route can require. */
export const ACCESS_LEVELS = Object.freeze(['use', 'edit', 'share', 'own']);

/** The tier policies the setting accepts; only `ihub` is implemented in phase 1. */
export const TIER_POLICIES = Object.freeze(['ihub', 'both', 'ifinder']);

/** The storage tiers a project can live in; only `ihub` is written in phase 1. */
export const PROJECT_TIERS = Object.freeze(['ihub', 'ifinder']);

/** Most items one project may hold, whatever an admin configures. */
export const MAX_FILES_CEILING = 50;

/** Most members one project may carry. */
export const MAX_MEMBERS = 100;

/** The access modes a link on an app, workflow or profile may declare. */
export const LINK_MODES = Object.freeze(['auto', 'context', 'tools']);
