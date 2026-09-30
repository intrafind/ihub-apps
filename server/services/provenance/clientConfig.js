/**
 * What the browser gets to know about EU AI Act transparency: the switches
 * that drive the disclosure, badges, labels and exports — no records, no
 * names of admins, no key material.
 *
 * @module services/provenance/clientConfig
 */
import { getAiTransparencyConfig, isAiTransparencyActive } from './config.js';
import { validDisclosureOptOut } from './markingPolicy.js';

/** `aiTransparency` block of `GET /api/configs/platform`. */
export function aiTransparencyClientConfig() {
  const active = isAiTransparencyActive();
  const cfg = getAiTransparencyConfig();
  return {
    enabled: active,
    interactionDisclosure: {
      enabled: active && cfg.interactionDisclosure.enabled,
      firstTurnNotice: cfg.interactionDisclosure.firstTurnNotice,
      persistentBadge: cfg.interactionDisclosure.persistentBadge,
      reminderInterval: cfg.interactionDisclosure.reminderInterval
    },
    labels: {
      messageBadge: active && cfg.labels.messageBadge,
      euIcon: cfg.labels.euIcon,
      exportLabel: cfg.labels.exportLabel,
      outbound: active && cfg.labels.outbound
    },
    text: {
      watermarkMinTokens: cfg.text.watermarkMinTokens,
      signpost: { ...cfg.text.signpost }
    },
    exports: { serverSide: true, sign: active && cfg.exports.sign },
    detection: { enabled: active && cfg.detection.enabled, access: cfg.detection.access },
    provider: { legalEntity: cfg.provider.legalEntity || '' }
  };
}

/**
 * An app as a chat client sees it: the raw records are replaced by the
 * effective settings (a foreign opt-out does not count — the disclosure is on).
 * @param {Object} app
 * @returns {Object}
 */
/**
 * Suffix for an ETag over `publicAppView` output. The views depend on the
 * platform-wide disclosure switch as well as on the apps, so a cached app list
 * must not survive that switch (per-app records are part of the app content).
 * @returns {string}
 */
export function publicAppViewTag() {
  const cfg = getAiTransparencyConfig();
  return isAiTransparencyActive() && cfg.interactionDisclosure.enabled ? 'd1' : 'd0';
}

export function publicAppView(app) {
  if (!app || typeof app !== 'object') return app;
  const block = app.aiTransparency || {};
  const cfg = getAiTransparencyConfig();
  const disclosure =
    isAiTransparencyActive() && cfg.interactionDisclosure.enabled && !validDisclosureOptOut(app);
  const view = {
    disclosure,
    ...(block.sensitive ? { sensitive: block.sensitive } : {}),
    ...(block.reminderInterval !== undefined ? { reminderInterval: block.reminderInterval } : {}),
    ...(block.firstTurnNotice ? { firstTurnNotice: block.firstTurnNotice } : {}),
    ...(block.signpost ? { signpost: block.signpost } : {}),
    ...(block.exemption ? { exemption: block.exemption.type } : {})
  };
  return { ...app, aiTransparency: view };
}
