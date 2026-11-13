// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import config from '../config.js';

/** Workers the cluster was configured with (1 outside cluster mode). */
export function getConfiguredWorkerCount() {
  return Math.max(1, Number(config.WORKERS) || 1);
}
