// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { lazy, Suspense } from 'react';

const UsageChart = lazy(() => import('./UsageChart'));

/** The usage chart, loaded on first use; a placeholder of the same height until then. */
export default function ChartSlot(props) {
  return (
    <Suspense
      fallback={<div className="h-60 animate-pulse rounded bg-gray-50 dark:bg-gray-900/30" />}
    >
      <UsageChart {...props} />
    </Suspense>
  );
}
