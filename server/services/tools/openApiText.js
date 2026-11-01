// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// js-yaml v5 is ESM-only with named exports — a default import throws
// "does not provide an export named 'default'" at module load time.
import { load as parseYaml, JSON_SCHEMA } from 'js-yaml';

/**
 * Parse an OpenAPI document body that may be JSON or YAML. Probes for the
 * leading `{`/`[` to choose JSON, otherwise falls back to YAML. Uses
 * `JSON_SCHEMA` so only JSON-compatible types (strings, numbers, booleans,
 * null, arrays, objects) are constructed — no custom YAML tags can produce
 * unexpected types from operator-supplied input. `json: true` makes duplicate
 * keys take the last value (matches JSON semantics).
 *
 * Kept apart from `OpenApiToolRunner.js` so readers of a document (the
 * integration registry) do not pull in the dereferencing parser.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseOpenApiText(text) {
  const trimmed = (text || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(text);
  }
  return parseYaml(text, { schema: JSON_SCHEMA, json: true });
}
