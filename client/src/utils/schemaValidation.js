/**
 * Schema Validation Utility
 * Provides JSON Schema validation for forms using Ajv
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Create and configure an Ajv instance for validation
 */
function createValidator() {
  const ajv = new Ajv({
    allErrors: true,
    verbose: true,
    strict: false,
    coerceTypes: true
  });

  // Add standard formats (email, uri, date-time, etc.)
  addFormats(ajv);

  return ajv;
}

/**
 * Preprocess data before validation
 * Converts empty strings to null for optional fields to avoid format validation issues
 * @param {Object} data - Data to preprocess
 * @param {Object} schema - JSON Schema
 * @returns {Object} Preprocessed data
 */
function preprocessData(data, schema) {
  if (!data || typeof data !== 'object' || !schema) {
    return data;
  }

  const required = schema.required || [];
  const properties = schema.properties || {};
  const processed = { ...data };

  Object.keys(processed).forEach(key => {
    // Convert empty strings to null for non-required fields with format validation
    if (processed[key] === '' && !required.includes(key) && properties[key]?.format) {
      processed[key] = null;
    }
  });

  return processed;
}

/**
 * Validate data against a JSON schema
 * @param {Object} data - Data to validate
 * @param {Object} schema - JSON Schema
 * @returns {Object} Validation result with isValid flag and errors
 */
export function validateWithSchema(data, schema) {
  if (!schema) {
    return { isValid: true, errors: [] };
  }

  // Preprocess data to handle empty strings for optional format fields
  const processedData = preprocessData(data, schema);

  const ajv = createValidator();
  const validate = ajv.compile(schema);
  const isValid = validate(processedData);

  if (!isValid) {
    return {
      isValid: false,
      errors: formatValidationErrors(validate.errors, schema)
    };
  }

  return { isValid: true, errors: [] };
}

/**
 * Format Ajv validation errors into user-friendly messages
 * @param {Array} ajvErrors - Raw Ajv errors
 * @param {Object} schema - JSON Schema for additional context
 * @returns {Array} Formatted error objects
 */
function formatValidationErrors(ajvErrors, schema) {
  if (!ajvErrors || !Array.isArray(ajvErrors)) return [];

  const errors = {};

  ajvErrors.forEach(error => {
    const { instancePath, keyword, message, params } = error;

    // Extract field name from instancePath
    let field = instancePath.replace(/^\//, '').replace(/\//g, '.');

    // Handle root-level required fields
    if (keyword === 'required' && params?.missingProperty) {
      field = params.missingProperty;
    }

    // Skip if we already have an error for this field
    if (errors[field]) return;

    // Get field schema for additional context
    const fieldSchema = getFieldSchema(schema, field);
    const fieldTitle = fieldSchema?.title || field;

    // Format error message based on keyword
    let formattedMessage;
    switch (keyword) {
      case 'required':
        formattedMessage = `${fieldTitle} is required`;
        break;
      case 'type':
        formattedMessage = `${fieldTitle} must be ${params?.type}`;
        break;
      case 'pattern':
        formattedMessage = fieldSchema?.patternError || `${fieldTitle} format is invalid`;
        break;
      case 'format':
        if (params?.format === 'email') {
          formattedMessage = `Please enter a valid email address`;
        } else if (params?.format === 'uri') {
          formattedMessage = `Please enter a valid URL`;
        } else {
          formattedMessage = `${fieldTitle} must be a valid ${params?.format}`;
        }
        break;
      case 'minLength':
        formattedMessage = `${fieldTitle} must be at least ${params?.limit} characters`;
        break;
      case 'maxLength':
        formattedMessage = `${fieldTitle} must be at most ${params?.limit} characters`;
        break;
      case 'minimum':
        formattedMessage = `${fieldTitle} must be at least ${params?.limit}`;
        break;
      case 'maximum':
        formattedMessage = `${fieldTitle} must be at most ${params?.limit}`;
        break;
      case 'enum':
        formattedMessage = `${fieldTitle} must be one of: ${params?.allowedValues?.join(', ')}`;
        break;
      case 'uniqueItems':
        formattedMessage = `${fieldTitle} must contain unique values`;
        break;
      default:
        formattedMessage = message || `${fieldTitle} is invalid`;
    }

    errors[field] = formattedMessage;
  });

  // Convert to array format for consistency
  return Object.entries(errors).map(([field, message]) => ({
    field,
    message,
    severity: 'error'
  }));
}

/**
 * Get field schema from a JSON schema by field path
 * @param {Object} schema - JSON Schema
 * @param {string} fieldPath - Field path (e.g., 'user.email')
 * @returns {Object|null} Field schema or null
 */
function getFieldSchema(schema, fieldPath) {
  if (!schema || !fieldPath) return null;

  const parts = fieldPath.split('.');
  let current = schema.properties;

  for (const part of parts) {
    if (!current || !current[part]) return null;

    if (current[part].properties) {
      current = current[part].properties;
    } else {
      return current[part];
    }
  }

  return null;
}

/**
 * Validate a single field against schema
 * @param {string} field - Field name
 * @param {any} value - Field value
 * @param {Object} schema - JSON Schema
 * @returns {string|null} Error message or null if valid
 */
export function validateField(field, value, schema) {
  if (!schema || !schema.properties || !schema.properties[field]) {
    return null;
  }

  // Create a minimal schema for just this field
  const fieldSchema = {
    type: 'object',
    properties: {
      [field]: schema.properties[field]
    }
  };

  // Add required constraint if applicable
  if (schema.required && schema.required.includes(field)) {
    fieldSchema.required = [field];
  }

  const result = validateWithSchema({ [field]: value }, fieldSchema);

  if (!result.isValid && result.errors.length > 0) {
    return result.errors[0].message;
  }

  return null;
}

/**
 * Get required fields from schema
 * @param {Object} schema - JSON Schema
 * @returns {Array} Array of required field names
 */
export function getRequiredFields(schema) {
  return schema?.required || [];
}

/**
 * Check if a field is required
 * @param {string} field - Field name
 * @param {Object} schema - JSON Schema
 * @returns {boolean} True if field is required
 */
export function isFieldRequired(field, schema) {
  return getRequiredFields(schema).includes(field);
}

/**
 * Convert schema validation errors to form field errors
 * @param {Array} errors - Validation errors from validateWithSchema
 * @returns {Object} Object with field names as keys and error messages as values
 */
export function errorsToFieldErrors(errors) {
  const fieldErrors = {};

  errors.forEach(error => {
    if (error.field && !fieldErrors[error.field]) {
      fieldErrors[error.field] = error.message;
    }
  });

  return fieldErrors;
}

/**
 * Validate password confirmation
 * @param {string} password - Password
 * @param {string} confirmPassword - Password confirmation
 * @returns {string|null} Error message or null if valid
 */
export function validatePasswordConfirmation(password, confirmPassword) {
  if (password && password !== confirmPassword) {
    return 'Passwords do not match';
  }
  return null;
}
