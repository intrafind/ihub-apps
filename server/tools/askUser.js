/**
 * Ask User Tool - Interactive User Clarification
 *
 * This tool allows LLMs to request clarification or additional input from users
 * when needed to better fulfill their requests. Instead of making assumptions,
 * the LLM can ask targeted questions to gather missing information.
 *
 * @module tools/askUser
 */

import logger from '../utils/logger.js';

/**
 * Maximum allowed length for the question text
 * @constant {number}
 */
const MAX_QUESTION_LENGTH = 500;

/**
 * Maximum number of options allowed for select/radio/checkbox inputs
 * @constant {number}
 */
const MAX_OPTIONS_COUNT = 20;

/**
 * Maximum length for option labels and values
 * @constant {number}
 */
const MAX_OPTION_LENGTH = 100;

/**
 * Maximum clarification requests per conversation (rate limiting)
 * @constant {number}
 */
export const MAX_CLARIFICATIONS_PER_CONVERSATION = 10;

/**
 * Supported input types for user clarification
 * @constant {string[]}
 */
const SUPPORTED_INPUT_TYPES = ['text', 'select', 'multiselect', 'confirm', 'number', 'date'];

/**
 * Regular expression patterns that are considered unsafe (ReDoS vulnerable)
 * These patterns can cause exponential backtracking
 * @constant {RegExp[]}
 */
const UNSAFE_REGEX_PATTERNS = [
  /\(\.\*\)\+/, // (.*)+
  /\(\.\+\)\+/, // (.+)+
  /\([^)]*\+[^)]*\)\+/, // nested quantifiers like (a+)+
  /\([^)]*\*[^)]*\)\+/, // nested quantifiers like (a*)+
  /\([^)]*\+[^)]*\)\*/, // nested quantifiers like (a+)*
  /\([^)]*\*[^)]*\)\*/, // nested quantifiers like (a*)*
  /\(\[.*?\]\+\)\+/, // ([...]+)+
  /\(\[.*?\]\*\)\+/, // ([...]*)+
  /\(\?:.*?\+.*?\)\+/, // (?:...+...)+
  /\(\?:.*?\*.*?\)\+/ // (?:...*...)+
];

/**
 * Validate that a regex pattern is safe (not vulnerable to ReDoS)
 * @param {string} pattern - The regex pattern string to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
function validateRegexPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') {
    return { valid: true }; // No pattern means no validation needed
  }

  // Check pattern length
  if (pattern.length > 200) {
    return { valid: false, error: 'Regex pattern too long (max 200 characters)' };
  }

  // Check for unsafe patterns that can cause ReDoS
  for (const unsafePattern of UNSAFE_REGEX_PATTERNS) {
    if (unsafePattern.test(pattern)) {
      return {
        valid: false,
        error: 'Regex pattern contains potentially unsafe nested quantifiers (ReDoS risk)'
      };
    }
  }

  // Try to compile the regex to ensure it's valid
  try {
    new RegExp(pattern);
  } catch (error) {
    return { valid: false, error: `Invalid regex pattern: ${error.message}` };
  }

  return { valid: true };
}

/**
 * Validate the options array for select/multiselect inputs
 * @param {Array} options - Array of option objects
 * @returns {{valid: boolean, error?: string}} Validation result
 */
function validateOptions(options) {
  if (!options || !Array.isArray(options)) {
    return { valid: true }; // No options is valid for non-select types
  }

  if (options.length > MAX_OPTIONS_COUNT) {
    return {
      valid: false,
      error: `Too many options (max ${MAX_OPTIONS_COUNT}, got ${options.length})`
    };
  }

  for (let i = 0; i < options.length; i++) {
    const option = options[i];

    if (!option || typeof option !== 'object') {
      return { valid: false, error: `Option at index ${i} must be an object` };
    }

    if (!option.label || typeof option.label !== 'string') {
      return { valid: false, error: `Option at index ${i} must have a string label` };
    }

    if (option.label.length > MAX_OPTION_LENGTH) {
      return {
        valid: false,
        error: `Option label at index ${i} too long (max ${MAX_OPTION_LENGTH} chars)`
      };
    }

    if (option.value !== undefined) {
      const valueStr = String(option.value);
      if (valueStr.length > MAX_OPTION_LENGTH) {
        return {
          valid: false,
          error: `Option value at index ${i} too long (max ${MAX_OPTION_LENGTH} chars)`
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Validate the ask_user tool parameters
 * @param {Object} params - The tool parameters
 * @returns {{valid: boolean, error?: string}} Validation result
 */
export function validateAskUserParams(params) {
  const { question, input_type, options, validation } = params;

  // Validate question
  if (!question || typeof question !== 'string') {
    return { valid: false, error: 'Question is required and must be a string' };
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    return {
      valid: false,
      error: `Question too long (max ${MAX_QUESTION_LENGTH} chars, got ${question.length})`
    };
  }

  // Validate input_type
  if (input_type && !SUPPORTED_INPUT_TYPES.includes(input_type)) {
    return {
      valid: false,
      error: `Invalid input_type. Supported types: ${SUPPORTED_INPUT_TYPES.join(', ')}`
    };
  }

  // Validate options for select types
  if (['select', 'multiselect'].includes(input_type)) {
    if (!options || !Array.isArray(options) || options.length === 0) {
      return {
        valid: false,
        error: `Options array is required for input_type '${input_type}'`
      };
    }
  }

  const optionsValidation = validateOptions(options);
  if (!optionsValidation.valid) {
    return optionsValidation;
  }

  // Validate regex pattern if provided
  if (validation && validation.pattern) {
    const regexValidation = validateRegexPattern(validation.pattern);
    if (!regexValidation.valid) {
      return regexValidation;
    }
  }

  return { valid: true };
}

/**
 * Ask the user a clarifying question
 *
 * This function is called by the LLM when it needs additional information
 * from the user. Instead of executing and returning a result, it signals
 * to the system that a clarification event should be emitted to the client.
 *
 * @param {Object} params - The clarification request parameters
 * @param {string} params.question - The question to ask the user (max 500 chars)
 * @param {string} [params.input_type='text'] - Type of input expected
 * @param {Array} [params.options] - Options for select/multiselect types
 * @param {boolean} [params.allow_other=false] - Allow free-text "other" option
 * @param {boolean} [params.allow_skip=false] - Allow skipping the question
 * @param {string} [params.placeholder] - Placeholder text for input field
 * @param {Object} [params.validation] - Validation rules for the input
 * @param {string} [params.context] - Additional context about why asking
 * @param {string} [params.chatId] - The chat ID for tracking
 * @returns {Object} The clarification request data to be emitted as an event
 * @throws {Error} If validation fails
 */
export default async function askUser({
  question,
  input_type = 'text',
  options,
  allow_other = false,
  allow_skip = false,
  placeholder,
  validation,
  context,
  chatId
}) {
  logger.info({
    component: 'askUser',
    message: 'Processing ask_user tool call',
    chatId,
    input_type,
    questionLength: question?.length
  });

  // Validate parameters
  const validationResult = validateAskUserParams({
    question,
    input_type,
    options,
    validation
  });

  if (!validationResult.valid) {
    logger.error({
      component: 'askUser',
      message: 'Validation failed',
      chatId,
      error: validationResult.error
    });
    throw new Error(validationResult.error);
  }

  // Build the clarification request object
  const clarificationRequest = {
    question,
    input_type: input_type || 'text',
    allow_skip: Boolean(allow_skip),
    timestamp: new Date().toISOString()
  };

  // Add optional fields if provided
  if (options && Array.isArray(options) && options.length > 0) {
    clarificationRequest.options = options.map(opt => ({
      label: opt.label,
      value: opt.value !== undefined ? opt.value : opt.label
    }));
  }

  if (allow_other) {
    clarificationRequest.allow_other = true;
  }

  if (placeholder) {
    clarificationRequest.placeholder = String(placeholder).substring(0, 200);
  }

  if (validation) {
    clarificationRequest.validation = {};
    if (validation.pattern) {
      clarificationRequest.validation.pattern = validation.pattern;
    }
    if (validation.min !== undefined) {
      clarificationRequest.validation.min = Number(validation.min);
    }
    if (validation.max !== undefined) {
      clarificationRequest.validation.max = Number(validation.max);
    }
    if (validation.message) {
      clarificationRequest.validation.message = String(validation.message).substring(0, 200);
    }
  }

  if (context) {
    clarificationRequest.context = String(context).substring(0, 500);
  }

  logger.info({
    component: 'askUser',
    message: 'Clarification request prepared',
    chatId,
    input_type: clarificationRequest.input_type
  });

  // Return the clarification request
  // The ToolExecutor will detect this is an ask_user tool and emit the appropriate event
  return {
    requiresUserInput: true,
    clarification: clarificationRequest
  };
}

/**
 * Tool metadata for the ask_user tool
 * This is used by the tool loader to understand special handling requirements
 */
export const toolMetadata = {
  id: 'ask_user',
  requiresUserInput: true,
  maxClarificationsPerConversation: MAX_CLARIFICATIONS_PER_CONVERSATION
};
