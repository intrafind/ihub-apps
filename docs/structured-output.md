# Structured Output Guide

This comprehensive guide covers how to implement structured output in iHub Apps, enabling your AI applications to return consistently formatted JSON responses instead of free-form text.

## Table of Contents

- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Progressive Examples](#progressive-examples)
- [Provider Implementation Guide](#provider-implementation-guide)
- [Integration Patterns](#integration-patterns)
- [Troubleshooting & Best Practices](#troubleshooting--best-practices)

## Quick Start

Get structured output working in under 5 minutes with this minimal example.

### Basic Setup

Add an `outputSchema` property to your app configuration:

```json
{
  "id": "data-extractor",
  "name": {
    "en": "Data Extractor",
    "de": "Datenextraktor"
  },
  "description": {
    "en": "Extract structured data from text",
    "de": "Strukturierte Daten aus Text extrahieren"
  },
  "system": {
    "en": "Extract key information from user input and return it in the specified JSON format.",
    "de": "Extrahiere wichtige Informationen aus Benutzereingaben und gib sie im angegebenen JSON-Format zurück."
  },
  "tokenLimit": 4000,
  "preferredOutputFormat": "json",
  "outputSchema": {
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "email": {"type": "string"},
      "phone": {"type": "string"}
    },
    "required": ["name", "email"]
  }
}
```

### Expected Output

When a user provides input like "John Doe, john@example.com, (555) 123-4567", the AI will return:

```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "(555) 123-4567"
}
```

That's it! iHub Apps automatically:
- Enables JSON mode for the selected LLM provider
- Validates the response against your schema
- Handles provider-specific implementation details

## Core Concepts

### JSON Schema Fundamentals

Structured output in iHub Apps uses [JSON Schema](https://json-schema.org/) to define the expected response format. Key schema elements include:

**Basic Types:**
- `string`: Text values
- `number`: Numeric values (integers or floats)
- `integer`: Whole numbers only
- `boolean`: true/false values
- `array`: Lists of items
- `object`: Nested structures

**Validation Keywords:**
- `required`: Array of required property names
- `minimum`/`maximum`: Numeric bounds
- `minLength`/`maxLength`: String length constraints
- `enum`: Allowed values from a predefined list
- `pattern`: Regular expression validation

### Provider-Specific Behavior

Each LLM provider implements structured output differently:

| Provider | Method | Validation Level | Performance |
|----------|--------|-----------------|-------------|
| **OpenAI** | `response_format: {type: 'json_object'}` | Basic JSON validation | Fast |
| **Mistral** | `json_schema` with strict mode | Full schema validation | Medium |
| **Anthropic** | Tool-based approach | Full schema validation | Medium |
| **Google Gemini** | `response_schema` configuration | Full schema validation | Fast |

### Automatic Provider Translation

iHub Apps automatically translates your `outputSchema` to the appropriate provider format:

- **OpenAI**: Sets `response_format: { type: 'json_object' }` and includes schema in system message
- **Mistral**: Uses `response_format: { type: 'json_schema', json_schema: { schema, name: 'response', strict: true } }`
- **Anthropic**: Creates a JSON tool with your schema and forces model to use it
- **Google Gemini**: Sets `generationConfig.response_mime_type` to `application/json` with `response_schema`

## Progressive Examples

### 1. Simple Object Schema

Start with a basic object structure:

```json
{
  "outputSchema": {
    "type": "object",
    "properties": {
      "summary": {"type": "string"},
      "sentiment": {"type": "string", "enum": ["positive", "neutral", "negative"]},
      "confidence": {"type": "number", "minimum": 0, "maximum": 1}
    },
    "required": ["summary", "sentiment"]
  }
}
```

**Use Case**: Sentiment analysis with confidence scoring

### 2. Nested Object Structures

Handle complex nested data:

```json
{
  "outputSchema": {
    "type": "object",
    "properties": {
      "person": {
        "type": "object",
        "properties": {
          "name": {"type": "string"},
          "age": {"type": "integer", "minimum": 0},
          "address": {
            "type": "object",
            "properties": {
              "street": {"type": "string"},
              "city": {"type": "string"},
              "zipCode": {"type": "string", "pattern": "^[0-9]{5}$"}
            },
            "required": ["street", "city"]
          }
        },
        "required": ["name", "age"]
      }
    },
    "required": ["person"]
  }
}
```

**Use Case**: Contact information extraction with validation

### 3. Array Handling

Work with lists and collections:

```json
{
  "outputSchema": {
    "type": "object",
    "properties": {
      "tasks": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "title": {"type": "string"},
            "priority": {"type": "string", "enum": ["high", "medium", "low"]},
            "dueDate": {"type": "string", "format": "date"},
            "completed": {"type": "boolean"}
          },
          "required": ["title", "priority"]
        },
        "minItems": 1,
        "maxItems": 10
      },
      "totalCount": {"type": "integer"}
    },
    "required": ["tasks", "totalCount"]
  }
}
```

**Use Case**: Task list generation and management

### 4. Complex Business Objects

Enterprise-grade structured data:

```json
{
  "outputSchema": {
    "type": "object",
    "properties": {
      "invoice": {
        "type": "object",
        "properties": {
          "id": {"type": "string", "pattern": "^INV-[0-9]{6}$"},
          "date": {"type": "string", "format": "date"},
          "customer": {
            "type": "object",
            "properties": {
              "companyName": {"type": "string"},
              "contactEmail": {"type": "string", "format": "email"},
              "taxId": {"type": "string"}
            },
            "required": ["companyName", "contactEmail"]
          },
          "items": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "description": {"type": "string"},
                "quantity": {"type": "integer", "minimum": 1},
                "unitPrice": {"type": "number", "minimum": 0},
                "total": {"type": "number", "minimum": 0}
              },
              "required": ["description", "quantity", "unitPrice", "total"]
            }
          },
          "subtotal": {"type": "number", "minimum": 0},
          "tax": {"type": "number", "minimum": 0},
          "total": {"type": "number", "minimum": 0}
        },
        "required": ["id", "date", "customer", "items", "subtotal", "tax", "total"]
      }
    },
    "required": ["invoice"]
  }
}
```

**Use Case**: Invoice processing and financial document extraction

## Provider Implementation Guide

### OpenAI Configuration

OpenAI uses a simple JSON mode approach:

```json
{
  "preferredModel": "gpt-4",
  "preferredOutputFormat": "json",
  "outputSchema": {
    "type": "object",
    "properties": {
      "answer": {"type": "string"},
      "sources": {
        "type": "array",
        "items": {"type": "string"}
      }
    }
  }
}
```

**OpenAI Behavior:**
- Sets `response_format: { type: 'json_object' }`
- Includes schema description in system message
- Performs basic JSON validation
- Does not enforce strict schema compliance

**Best Practices:**
- Include clear schema descriptions in system prompts
- Use simple structures for better reliability
- Add validation logic in your application if strict compliance is needed

### Mistral Configuration

Mistral provides strict schema validation:

```json
{
  "preferredModel": "mistral-large",
  "preferredOutputFormat": "json",
  "outputSchema": {
    "type": "object",
    "properties": {
      "classification": {
        "type": "string",
        "enum": ["urgent", "normal", "low"]
      },
      "reasoning": {"type": "string"}
    },
    "required": ["classification", "reasoning"]
  }
}
```

**Mistral Behavior:**
- Uses `json_schema` with `strict: true` mode
- Enforces full schema compliance
- Rejects responses that don't match schema
- Provides detailed validation errors

**Best Practices:**
- Design schemas carefully as strict validation is enforced
- Test schema thoroughly with various inputs
- Use appropriate constraints (required fields, enums, etc.)

### Anthropic Configuration

Anthropic uses a tool-based approach:

```json
{
  "preferredModel": "claude-3-5-sonnet-20241022",
  "preferredOutputFormat": "json",
  "outputSchema": {
    "type": "object",
    "properties": {
      "analysis": {
        "type": "object",
        "properties": {
          "keyPoints": {
            "type": "array",
            "items": {"type": "string"}
          },
          "recommendation": {"type": "string"},
          "confidence": {"type": "number", "minimum": 0, "maximum": 1}
        }
      }
    }
  }
}
```

**Anthropic Behavior:**
- Creates a JSON tool with your schema
- Forces model to use the tool for responses
- Provides excellent schema compliance
- Supports complex nested structures

**Best Practices:**
- Leverage Anthropic's strong reasoning for complex schemas
- Use detailed property descriptions
- Test with edge cases and complex nested data

### Google Gemini Configuration

Gemini has native structured output support:

```json
{
  "preferredModel": "gemini-2.0-flash",
  "preferredOutputFormat": "json",
  "outputSchema": {
    "type": "object",
    "properties": {
      "entities": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "text": {"type": "string"},
            "type": {"type": "string"},
            "confidence": {"type": "number"}
          }
        }
      }
    }
  }
}
```

**Gemini Behavior:**
- Sets `response_mime_type: "application/json"`
- Uses `response_schema` for validation
- Fast processing with good compliance
- Excellent for entity extraction and classification

**Best Practices:**
- Use Gemini for high-throughput structured extraction
- Leverage native JSON support for complex arrays
- Test with multilingual content if needed

## Integration Patterns

### Frontend Handling

Handle structured responses in your frontend application:

```javascript
// In your chat component
const handleStructuredResponse = (response) => {
  try {
    const parsedData = JSON.parse(response.content);
    
    // Validate structure if needed
    if (parsedData.summary && parsedData.keyPoints) {
      displayStructuredContent(parsedData);
    } else {
      fallbackToTextDisplay(response.content);
    }
  } catch (error) {
    console.warn('Failed to parse structured response:', error);
    fallbackToTextDisplay(response.content);
  }
};

const displayStructuredContent = (data) => {
  // Create custom UI for structured data
  return (
    <div className="structured-response">
      <h3>{data.summary}</h3>
      <ul>
        {data.keyPoints.map((point, index) => (
          <li key={index}>{point}</li>
        ))}
      </ul>
      {data.confidence && (
        <div className="confidence">
          Confidence: {Math.round(data.confidence * 100)}%
        </div>
      )}
    </div>
  );
};
```

### Validation Workflows

Implement server-side validation:

```javascript
// Server-side validation example
const validateStructuredOutput = (response, schema) => {
  try {
    const data = JSON.parse(response);
    
    // Basic schema validation
    const ajv = new Ajv();
    const validate = ajv.compile(schema);
    const valid = validate(data);
    
    if (!valid) {
      console.error('Schema validation errors:', validate.errors);
      return { valid: false, errors: validate.errors, data: null };
    }
    
    return { valid: true, errors: null, data };
  } catch (error) {
    return { valid: false, errors: [error.message], data: null };
  }
};
```

### App Configuration Integration

Complete app configuration with structured output:

```json
{
  "id": "document-analyzer",
  "name": {
    "en": "Document Analyzer",
    "de": "Dokumentanalysator"
  },
  "description": {
    "en": "Analyze documents and extract structured information",
    "de": "Analysiere Dokumente und extrahiere strukturierte Informationen"
  },
  "system": {
    "en": "You are a document analysis expert. Extract key information from the provided document and structure it according to the specified schema. Be thorough and accurate in your analysis.",
    "de": "Du bist ein Experte für Dokumentenanalyse. Extrahiere wichtige Informationen aus dem bereitgestellten Dokument und strukturiere sie nach dem angegebenen Schema. Sei gründlich und genau in deiner Analyse."
  },
  "tokenLimit": 8000,
  "preferredModel": "gpt-4",
  "preferredOutputFormat": "json",
  "sendChatHistory": false,
  "outputSchema": {
    "type": "object",
    "properties": {
      "documentType": {
        "type": "string",
        "enum": ["contract", "invoice", "report", "letter", "other"]
      },
      "keyInformation": {
        "type": "object",
        "properties": {
          "title": {"type": "string"},
          "date": {"type": "string"},
          "parties": {
            "type": "array",
            "items": {"type": "string"}
          },
          "summary": {"type": "string"}
        }
      },
      "extractedData": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "field": {"type": "string"},
            "value": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1}
          }
        }
      }
    },
    "required": ["documentType", "keyInformation"]
  },
  "upload": {
    "enabled": true,
    "fileUpload": {
      "maxFileSizeMB": 10,
      "supportedPdfFormats": ["application/pdf"]
    }
  }
}
```

## Troubleshooting & Best Practices

### Common Schema Validation Errors

**Error: Invalid JSON format**
```
SyntaxError: Unexpected token in JSON
```
**Solution**: Ensure your schema uses valid JSON Schema syntax. Common issues include:
- Missing quotes around property names
- Trailing commas in objects/arrays
- Invalid property types or formats

**Error: Required property missing**
```
ValidationError: Missing required property 'fieldName'
```
**Solution**: 
- Review your `required` array
- Check if LLM is generating all required fields
- Consider making some fields optional during testing

**Error: Type mismatch**
```
ValidationError: Expected string but got number
```
**Solution**:
- Verify property types in your schema
- Add type conversion logic if needed
- Use `oneOf` for flexible typing

### Performance Considerations

**Schema Complexity**
- Simple schemas (1-5 properties): Excellent performance across all providers
- Medium schemas (5-15 properties): Good performance, may require optimization
- Complex schemas (15+ properties): Consider breaking into smaller chunks

**Token Usage**
- Structured output typically uses 10-20% more tokens than free-form text
- Complex schemas increase token usage significantly
- Use appropriate `tokenLimit` settings

**Provider Performance Comparison**
| Provider | Simple Schema | Complex Schema | Validation Quality |
|----------|---------------|----------------|-------------------|
| OpenAI | Excellent | Good | Basic |
| Mistral | Good | Good | Excellent |
| Anthropic | Good | Excellent | Excellent |
| Gemini | Excellent | Good | Good |

### Schema Design Principles

**1. Start Simple**
Begin with basic structures and add complexity gradually:

```json
// ✅ Good: Start simple
{
  "type": "object",
  "properties": {
    "name": {"type": "string"},
    "category": {"type": "string"}
  }
}

// ❌ Avoid: Complex initial schema
{
  "type": "object",
  "properties": {
    "complexNestedStructure": {
      "type": "object",
      "properties": {
        "multipleArrays": {
          "type": "array",
          "items": {
            "oneOf": [
              {"type": "string"},
              {"type": "object", "properties": {...}}
            ]
          }
        }
      }
    }
  }
}
```

**2. Use Clear Property Names**
```json
// ✅ Good: Descriptive names
{
  "properties": {
    "customerName": {"type": "string"},
    "invoiceDate": {"type": "string"},
    "totalAmount": {"type": "number"}
  }
}

// ❌ Avoid: Ambiguous names
{
  "properties": {
    "n": {"type": "string"},
    "d": {"type": "string"},
    "amt": {"type": "number"}
  }
}
```

**3. Include Appropriate Constraints**
```json
{
  "properties": {
    "email": {
      "type": "string",
      "format": "email"
    },
    "age": {
      "type": "integer",
      "minimum": 0,
      "maximum": 150
    },
    "priority": {
      "type": "string",
      "enum": ["low", "medium", "high"]
    }
  }
}
```

**4. Handle Optional Fields Thoughtfully**
```json
{
  "type": "object",
  "properties": {
    "required_field": {"type": "string"},
    "optional_field": {
      "type": "string",
      "default": "N/A"
    }
  },
  "required": ["required_field"]
}
```

### Testing Strategies

**1. Schema Validation Testing**
```bash
# Test with various inputs
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "your-app-id",
    "message": "Test input for schema validation"
  }'
```

**2. Edge Case Testing**
- Empty inputs
- Very long inputs
- Special characters
- Multiple languages
- Malformed data

**3. Provider Comparison Testing**
Test the same schema across different providers to understand behavior differences.

### Security Considerations

**1. Input Validation**
Always validate structured output on the server side, even with schema validation:

```javascript
const sanitizeStructuredOutput = (data) => {
  // Remove potentially dangerous content
  const sanitized = {...data};
  
  // Example: Remove script tags from strings
  Object.keys(sanitized).forEach(key => {
    if (typeof sanitized[key] === 'string') {
      sanitized[key] = sanitized[key].replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    }
  });
  
  return sanitized;
};
```

**2. Data Privacy**
Be cautious with sensitive data in structured output:
- Avoid including PII in example schemas
- Implement data masking for sensitive fields
- Use secure storage for extracted structured data

**3. Rate Limiting**
Structured output can be computationally expensive:
- Implement appropriate rate limiting
- Monitor token usage patterns
- Set reasonable complexity limits

## Related Documentation

- **[Tool Calling Guide](tool-calling.md)**: Learn how to combine structured output with tool calling for advanced workflows
- **[App Configuration](apps.md#structured-output)**: Complete app configuration reference with structured output examples
- **[Models Configuration](models.md)**: LLM provider setup and configuration
- **[Upload Features](file-upload-feature.md)**: Process documents and extract structured data
- **[Troubleshooting Guide](troubleshooting.md)**: General troubleshooting tips for iHub Apps

---

*This documentation follows iHub Apps best practices for structured output implementation. For additional support, refer to the troubleshooting section or consult the community resources.*