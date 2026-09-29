import { Suspense } from 'react';
import { useAuth } from '../../../../shared/contexts/AuthContext';
import lazyWithRetry from '../../../../utils/lazyWithRetry';
import { isComplianceBannerUser } from '../../utils/euAiAct';

// The panel (fetch, dialog, admin API client) is only downloaded for admins.
// The start page is in the main bundle and every user loads it; non-admins
// must not pay for — or ever trigger — the admin banner.
const ComplianceBannerPanel = lazyWithRetry(() => import('./ComplianceBannerPanel'));

/**
 * EU AI Act compliance banner for administrators (concept §8.6), shown on the
 * start page and the admin overview.
 *
 * Renders nothing — and fetches nothing — unless the signed-in user is a full
 * admin (`user.isAdmin` or `permissions.adminAccess`; never content admins or
 * the anonymous principal). For admins it lazy-loads
 * {@link ComplianceBannerPanel}, which fetches `GET /admin/ai-transparency/banner`
 * and renders nothing while there are no active warnings.
 *
 * @param {Object} props
 * @param {string} [props.className] - Spacing classes for the banner box,
 *   e.g. `mb-6`. Only applied when the banner is visible.
 */
function ComplianceBanner({ className = '' }) {
  const { user } = useAuth();
  if (!isComplianceBannerUser(user)) return null;
  return (
    <Suspense fallback={null}>
      <ComplianceBannerPanel className={className} />
    </Suspense>
  );
}

export default ComplianceBanner;
