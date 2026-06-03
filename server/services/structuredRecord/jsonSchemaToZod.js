import { z } from 'zod';

/**
 * Convert a JSON-Schema fragment to a Zod schema covering the subset that
 * iHub workflow authors actually use in `outputSchema` declarations.
 *
 * Supports: object/array/string/number/integer/boolean leaf types,
 * `properties` + `required`, `items`, `enum`. Unknown types degrade to
 * `z.unknown()` so unrecognised shapes fall through rather than throwing.
 *
 * This is a deliberately narrow translator — not a full JSON Schema
 * compiler. If a workflow needs `oneOf`, `pattern`, format validators,
 * or other advanced features, register a named schema in `schemas.js`
 * instead.
 *
 * @param {Object} schema  JSON Schema fragment
 * @returns {import('zod').ZodTypeAny}
 */
export function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== 'object') return z.unknown();

  if (Array.isArray(schema.enum)) {
    return z.enum(schema.enum.map(v => String(v)));
  }

  const { type } = schema;
  if (type === 'string') return z.string();
  if (type === 'number') return z.number();
  if (type === 'integer') return z.number().int();
  if (type === 'boolean') return z.boolean();
  if (type === 'null') return z.null();
  if (type === 'array') {
    return z.array(schema.items ? jsonSchemaToZod(schema.items) : z.unknown());
  }
  if (type === 'object') {
    const props = schema.properties || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const shape = {};
    for (const [key, val] of Object.entries(props)) {
      const fieldSchema = jsonSchemaToZod(val);
      shape[key] = required.has(key) ? fieldSchema : fieldSchema.optional();
    }
    return z.object(shape).passthrough();
  }

  return z.unknown();
}

export default jsonSchemaToZod;
