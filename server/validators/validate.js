// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Creates an Express middleware that validates request data against Zod schemas.
 * Validates body, query, and params if corresponding schemas are provided.
 * Replaces request data with parsed/validated data on success. A failure goes to the
 * global error middleware: `400 { error, code: 'VALIDATION_FAILED', details: { issues } }`.
 * @param {Object} schemas - Object containing Zod schemas for validation
 * @param {import('zod').ZodSchema} [schemas.body] - Schema for request body validation
 * @param {import('zod').ZodSchema} [schemas.query] - Schema for query parameters validation
 * @param {import('zod').ZodSchema} [schemas.params] - Schema for route parameters validation
 * @returns {Function} Express middleware function (req, res, next)
 */
export default function validate(schemas = {}) {
  return (req, res, next) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        // Express 5 defines req.query as a getter-only accessor, so it must be
        // redefined instead of assigned.
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      next();
    } catch (error) {
      // A ZodError becomes 400 VALIDATION_FAILED with `details.issues` in the global
      // error middleware (utils/errorResponse.js); anything else is a 500 there.
      return next(error);
    }
  };
}
