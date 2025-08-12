export function normalizeName(name) {
  const normalized = (name || '').replace(/[^A-Za-z0-9_.-]/g, '_');

  // Ensure name starts with letter or underscore (Google requirement)
  if (normalized && !/^[A-Za-z_]/.test(normalized)) {
    return `tool_${normalized}`;
  }

  // Ensure name is not empty
  return normalized || 'unnamed_tool';
}

/**
 * Sanitize JSON Schema for provider compatibility
 * Removes unsupported fields and formats for specific providers
 */
function sanitizeSchemaForProvider(schema, provider) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }

  const sanitized = JSON.parse(JSON.stringify(schema)); // Deep clone

  function cleanObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    // Remove OpenAI-specific fields that Google doesn't support
    if (provider === 'google') {
      delete obj.exclusiveMaximum;
      delete obj.exclusiveMinimum;
      delete obj.title;
      delete obj.format; // Google has limited format support
      delete obj.minLength; // Use 'minimum' instead for strings
      delete obj.maxLength; // Use 'maximum' instead for strings
    }

    // Recursively clean nested objects
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === 'object') {
        if (Array.isArray(obj[key])) {
          obj[key] = obj[key].map(item => cleanObject(item));
        } else {
          obj[key] = cleanObject(obj[key]);
        }
      }
    }

    return obj;
  }

  return cleanObject(sanitized);
}

export function formatToolsForOpenAI(tools = []) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: normalizeName(t.id || t.name || 'unnamed_tool'),
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} }
    }
  }));
}

export function formatToolsForAnthropic(tools = []) {
  return tools.map(t => {
    // Handle OpenAI tool format with nested function structure
    if (t.type === 'function' && t.function) {
      return {
        name: normalizeName(t.function.name),
        description: t.function.description || '',
        input_schema: sanitizeSchemaForProvider(t.function.parameters, 'anthropic')
      };
    }

    // Handle flat tool format
    return {
      name: normalizeName(t.id),
      description: t.description || '',
      input_schema: sanitizeSchemaForProvider(t.parameters, 'anthropic')
    };
  });
}

export function formatToolsForGoogle(tools = []) {
  return [
    {
      functionDeclarations: tools.map(t => {
        // Handle OpenAI tool format with nested function structure
        if (t.type === 'function' && t.function) {
          return {
            name: normalizeName(t.function.name),
            description: t.function.description || '',
            parameters: sanitizeSchemaForProvider(t.function.parameters, 'google')
          };
        }

        // Handle flat tool format
        return {
          name: normalizeName(t.id),
          description: t.description || '',
          parameters: sanitizeSchemaForProvider(t.parameters, 'google')
        };
      })
    }
  ];
}
