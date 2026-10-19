// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { withErrorBoundary } from './ErrorBoundary';

export const withSafeRoute = Component => {
  return withErrorBoundary(Component);
};
