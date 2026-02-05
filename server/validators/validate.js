import { ZodError } from 'zod';

/**
 * Creates an Express middleware that validates request data against Zod schemas.
 * Validates body, query, and params if corresponding schemas are provided.
 * Replaces request data with parsed/validated data on success.
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
        req.query = schemas.query.parse(req.query);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: 'Invalid request', details: err.errors });
      }
      return next(err);
    }
  };
}
