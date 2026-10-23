// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  addAdminProjectItem,
  checkProjectPickerUrl,
  fetchProjectPickerPages,
  getAdminApiErrorMessage,
  searchProjectPickerIFinder,
  uploadAdminProjectItem
} from '../../../api/adminApi';

/**
 * What the shared "Add item" dialog calls for an admin project: the admin
 * item routes and the user picker endpoints. Admin projects get no cloud tab.
 */
export const ADMIN_ITEM_API = {
  addItem: (...args) => addAdminProjectItem(...args),
  uploadItem: (...args) => uploadAdminProjectItem(...args),
  fetchPages: () => fetchProjectPickerPages(),
  searchIFinder: query => searchProjectPickerIFinder(query),
  checkUrl: url => checkProjectPickerUrl(url),
  errorMessage: err => getAdminApiErrorMessage(err)
};
