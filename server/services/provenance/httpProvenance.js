// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Small helpers that put a provenance object on each channel's wire format. Each one is a
 * no-op while the EU AI Act master switch is off: no header, no member (absent, not null).
 *
 * @module services/provenance/httpProvenance
 */

import { isEuAiActEnabled } from '../euAiAct/conformity.js';

export const HEADER_AI_GENERATED = 'X-AI-Generated';
export const HEADER_CONTENT_ID = 'X-AI-Content-Id';

/**
 * Set the two headers. Streaming headers are final once flushed, so call this
 * before the first byte, with an id allocated up front.
 *
 * @param {import('express').Response} res
 * @param {string} outputId
 */
export function applyProvenanceHeaders(res, outputId) {
  if (!isEuAiActEnabled() || !outputId || res.headersSent) return;
  res.setHeader(HEADER_AI_GENERATED, 'true');
  res.setHeader(HEADER_CONTENT_ID, outputId);
}

/** A copy of `body` with a top-level `provenance` member (unchanged without one). */
export function withProvenance(body, provenance) {
  return provenance && isEuAiActEnabled() ? { ...body, provenance } : body;
}

/** The MCP result `_meta` for a provenance object, merged over existing meta. */
export function mcpMeta(provenance, existing) {
  return provenance && isEuAiActEnabled() ? { ...(existing || {}), provenance } : existing;
}

/** A2A metadata member for a provenance object, merged over existing metadata. */
export function a2aMetadata(provenance, existing) {
  return provenance && isEuAiActEnabled() ? { ...(existing || {}), provenance } : existing;
}
