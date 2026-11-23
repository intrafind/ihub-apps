// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The form a cloned group opens with: everything of the original (name,
 * description, permissions, inherited groups, usage limits) except its ID and
 * its external mappings. Pure.
 *
 * The ID is the one proposed by `copyId` (`<id>-copy`); the admin can still
 * change it before saving. Mappings are left out on purpose: a mapping puts
 * the members of an IdP group into the group, so a copied mapping would give
 * those users the copy's permissions the moment it is saved, before the admin
 * has changed anything.
 *
 * @param {object} defaults - The form of a new, empty group.
 * @param {object} template - The group being cloned, as the list loaded it.
 * @param {string} [cloneId] - The proposed ID of the copy.
 * @returns {object} The initial form of the copy.
 *
 * @example
 * groupCloneDraft(emptyGroup, { id: 'sales', name: 'Sales', mappings: ['Sales'] }, 'sales-copy');
 * // → { ...emptyGroup, name: 'Sales', id: 'sales-copy', mappings: [] }
 */
export function groupCloneDraft(defaults, template, cloneId) {
  return { ...defaults, ...template, id: cloneId ?? '', mappings: [] };
}
