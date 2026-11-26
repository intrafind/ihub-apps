// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  addAdminProjectItem,
  checkProjectPickerUrl,
  crawlProjectPickerUrl,
  fetchProjectPickerIFinderProfiles,
  fetchProjectPickerPages,
  getAdminApiErrorMessage,
  importAdminProjectItems,
  previewProjectPickerUrl,
  searchProjectPickerIFinder,
  uploadAdminProjectItem
} from '../../../api/adminApi';

/**
 * What the shared "Add item" dialog calls for an admin project: the admin
 * item routes and the user picker endpoints. Admin projects get no cloud tab.
 * A ZIP archive goes to the admin import route, which unpacks it.
 */
export const ADMIN_ITEM_API = {
  addItem: (...args) => addAdminProjectItem(...args),
  uploadItem: (...args) => uploadAdminProjectItem(...args),
  importItem: (projectId, upload) => importAdminProjectItems(projectId, upload),
  fetchPages: () => fetchProjectPickerPages(),
  searchIFinder: (query, options) => searchProjectPickerIFinder(query, options),
  fetchIFinderProfiles: () => fetchProjectPickerIFinderProfiles(),
  checkUrl: url => checkProjectPickerUrl(url),
  previewUrl: url => previewProjectPickerUrl(url),
  crawlUrl: (url, options) => crawlProjectPickerUrl(url, options),
  errorMessage: err => getAdminApiErrorMessage(err)
};
