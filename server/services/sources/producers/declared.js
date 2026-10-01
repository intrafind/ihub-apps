/**
 * Sources declared in a tool definition: a mapping from the tool's result to
 * sources, so a tool whose result does not speak the contract (an OpenAPI
 * tool, a script written before it) reports what it found without code.
 *
 * In `tools/<id>.json`, for the whole tool or per function (the function's
 * declaration wins):
 *
 * ```json
 * "sources": {
 *   "provider": "jira",
 *   "kind": "item",
 *   "list": "issues",
 *   "fields": { "id": "key", "title": "fields.summary", "url": "webUrl",
 *               "snippet": "fields.status.name", "publishedDate": "fields.updated" },
 *   "ref": { "id": "key" },
 *   "query": "jql",
 *   "public": false
 * }
 * ```
 *
 * - `list` — path to the hits in the result; without it the result itself (an
 *   array of hits, or one hit).
 * - `fields` — path per source field inside a hit: `id`, `title`, `url`,
 *   `site`, `snippet`, `publishedDate`, `fileName`, `type`, `favicon`.
 * - `ref` — paths to the handle a source provider acts on (`id`, `scope`).
 *   Only a provider registered on the server (`ifinder`) turns it into
 *   actions; a tool that returns iFinder document ids and declares
 *   `"provider": "ifinder"` gets Preview, Download and Add to email.
 * - `query` — the argument that holds what was searched for.
 * - `public` — whether a share may show the hits (default: no).
 *
 * Paths are dot-separated (`fields.summary`, `items.0.url`); a key that
 * itself contains dots (`accessInfo.deepLink`) is matched as a whole first.
 *
 * @module services/sources/producers/declared
 */
import { z } from 'zod';
import { SOURCE_KINDS } from '../../../../shared/sources/index.js';
import logger from '../../../utils/logger.js';

const path = z.string().min(1).max(200);

export const sourceDeclarationSchema = z
  .object({
    provider: z
      .string()
      .regex(/^[\w.:-]{1,100}$/)
      .optional(),
    kind: z.enum(SOURCE_KINDS).optional(),
    list: path.optional(),
    fields: z
      .object({
        id: path.optional(),
        title: path.optional(),
        url: path.optional(),
        site: path.optional(),
        snippet: path.optional(),
        publishedDate: path.optional(),
        fileName: path.optional(),
        type: path.optional(),
        favicon: path.optional()
      })
      .strict(),
    ref: z.object({ id: path, scope: path.optional() }).strict().optional(),
    query: z.string().min(1).max(100).optional(),
    public: z.boolean().optional()
  })
  .strict();

/** Declarations already checked, so an invalid one is reported once. */
const checked = new WeakMap();

/**
 * The declaration that applies to a tool call, validated.
 *
 * @param {Object|undefined} toolDef - the resolved tool (a function tool
 *   carries its parent's `functions` and its own `method`)
 * @returns {Object|null}
 */
export function declarationOf(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') return null;
  const own = toolDef.method ? toolDef.functions?.[toolDef.method]?.sources : undefined;
  const declaration = own ?? toolDef.sources;
  if (!declaration || typeof declaration !== 'object') return null;
  if (checked.has(declaration)) return checked.get(declaration);
  const parsed = sourceDeclarationSchema.safeParse(declaration);
  if (!parsed.success) {
    logger.warn('Ignoring invalid sources declaration', {
      component: 'sources',
      toolId: toolDef.id,
      issues: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
    });
  }
  const valid = parsed.success ? parsed.data : null;
  checked.set(declaration, valid);
  return valid;
}

/** The value at a dot path; a key containing dots is matched whole first. */
function valueAt(value, dotted) {
  if (!dotted) return value;
  if (value && typeof value === 'object' && dotted in value) return value[dotted];
  const [head, ...rest] = dotted.split('.');
  if (!rest.length) return value && typeof value === 'object' ? value[head] : undefined;
  if (!value || typeof value !== 'object') return undefined;
  if (!(head in value)) return undefined;
  return valueAt(value[head], rest.join('.'));
}

/**
 * @param {Object} declaration - from {@link declarationOf}
 * @param {{args?: Object, result: unknown}} call - `result` parsed from JSON text already
 * @returns {{items: Array, queries: string[], defaults: Object}}
 */
export function declaredSources(declaration, { args, result }) {
  const query = declaration.query ? args?.[declaration.query] : null;
  const queries = typeof query === 'string' ? [query] : [];
  const defaults = {
    ...(declaration.provider ? { provider: declaration.provider } : {}),
    ...(declaration.kind ? { kind: declaration.kind } : {}),
    private: declaration.public !== true
  };
  const listed = valueAt(result, declaration.list);
  const hits = Array.isArray(listed)
    ? listed
    : listed && typeof listed === 'object'
      ? [listed]
      : [];
  const items = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue;
    const source = {};
    for (const [field, fieldPath] of Object.entries(declaration.fields)) {
      const value = valueAt(hit, fieldPath);
      if (value !== undefined && value !== null) source[field] = value;
    }
    if (declaration.ref) {
      const id = valueAt(hit, declaration.ref.id);
      const scope = declaration.ref.scope ? valueAt(hit, declaration.ref.scope) : undefined;
      if (id !== undefined && id !== null) source.ref = { id, scope };
    }
    items.push(source);
  }
  return { items, queries, defaults };
}
