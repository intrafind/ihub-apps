// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import registerAgentRunRoutes from './runs.js';
import registerAgentArtifactRoutes from './artifacts.js';

export default function registerAgentRoutes(app) {
  registerAgentRunRoutes(app);
  registerAgentArtifactRoutes(app);
}
