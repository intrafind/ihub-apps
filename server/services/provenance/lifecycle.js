/**
 * Startup of the EU AI Act transparency subsystem.
 *
 * @module services/provenance/lifecycle
 */
import logger from '../../utils/logger.js';
import { getAiTransparencyConfig, isAiTransparencyActive } from './config.js';
import { ensureInstallationId } from './installation.js';
import signingService from './signing/SigningService.js';
import { warmUpTrustmark } from './image/ImageMarker.js';
import provenanceStore from './ProvenanceStore.js';
import detectionLog from './detection/DetectionLog.js';

const DAY_MS = 24 * 60 * 60 * 1000;
let sweepTimer = null;

/**
 * @param {{ownsSingletons?: boolean}} [opts] - whether this worker runs the cluster-wide sweeps
 */
export async function initAiTransparency({ ownsSingletons = true } = {}) {
  await ensureInstallationId();
  // Retention sweeps run even while the feature is off: it can be switched on
  // at runtime, and each sweep reads the current retention settings.
  if (ownsSingletons && !sweepTimer) {
    const sweep = () => {
      provenanceStore.sweep().catch(() => {});
      detectionLog.sweep().catch(() => {});
    };
    setTimeout(sweep, 60 * 1000).unref?.();
    sweepTimer = setInterval(sweep, DAY_MS);
    sweepTimer.unref?.();
  }
  if (!isAiTransparencyActive()) return;
  const cfg = getAiTransparencyConfig();
  if (cfg.signing.enabled) {
    try {
      await signingService.ensureCertificate();
    } catch (error) {
      logger.error('Could not create the installation signing certificate', {
        component: 'Provenance',
        error: error.message
      });
    }
  }
  warmUpTrustmark();
}
