// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Link handlers of the project items (#1036): the URL, iFinder and page
 * handlers behind the `url`, `page`, `ifinder-document` and `ifinder-query`
 * kinds, and the manager that registers them and probes a URL for the
 * picker. The prompt-time loading of the former sources is gone with them.
 */

import SourceHandler from './SourceHandler.js';
import URLHandler from './URLHandler.js';
import IFinderHandler from './IFinderHandler.js';
import PageHandler from './PageHandler.js';
import SourceManager from './SourceManager.js';

// Singleton instance of SourceManager
let singletonSourceManager = null;

// Factory function to create source manager with default configuration.
// NOTE: this is a process-wide singleton — `config` is only honored on the
// very first call. Later calls, regardless of what they pass, receive the
// already-constructed instance unchanged. Callers that need a custom
// filesystem basePath etc. must ensure that config is supplied by whichever
// call happens to run first, or rely on the handler defaults instead.
export const createSourceManager = (config = {}) => {
  if (!singletonSourceManager) {
    singletonSourceManager = new SourceManager(config);
  }
  return singletonSourceManager;
};

// Export all components
export { SourceHandler, URLHandler, IFinderHandler, PageHandler, SourceManager };
