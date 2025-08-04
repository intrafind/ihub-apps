# Centralized PDF Export Implementation Plan

## Executive Summary

This document provides a detailed, step-by-step implementation guide for the centralized PDF export refactoring project. Based on the comprehensive design review and security analysis, this plan prioritizes immediate security fixes while delivering a robust, extensible solution over 12 weeks.

## Project Context

**Current State**: 3 separate PDF implementations with critical security vulnerabilities:
- Canvas Export: Basic HTML + window.print (XSS vulnerable)
- Chat Export: Complex client-side PDF with 400+ lines
- Mermaid Export: SVG-to-PNG with jsPDF integration

**Target State**: Unified, secure, performant PDF export service with plugin architecture

## Implementation Timeline Overview

```
Week 0-1:  🚨 Critical Security Fixes + Planning
Week 1-4:  🏗️  Core Infrastructure (Base Classes + Security)
Week 4-6:  🎨 Content Processors (HTML, SVG, Canvas, Chat)
Week 6-9:  ⚛️  React Integration (Components + Migration)
Week 9-12: 🚀 Testing, Optimization & Production Deployment
```

---

## Phase 0: Immediate Actions (Week 0-1)

### 🚨 Critical Security Fixes

**Objective**: Eliminate XSS vulnerabilities in existing implementations

#### Deliverables

1. **Canvas Export Security Patch**
   - File: `client/src/features/canvas/components/ExportMenu.jsx`
   - Fix XSS in lines 27-49

2. **Chat Export Security Patch** 
   - File: `client/src/api/endpoints/apps.js`
   - Fix HTML injection in formatContent function

#### Implementation

**1.1 Canvas Export Security Fix**

```javascript
// client/src/features/canvas/components/ExportMenu.jsx
import DOMPurify from 'dompurify';

const handlePrintPDF = () => {
  // SECURITY: Sanitize content before injecting
  const sanitizedContent = DOMPurify.sanitize(content, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'p', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'code'],
    ALLOWED_ATTR: []
  });
  
  const printWindow = window.open('', '_blank');
  const doc = printWindow.document;
  
  // Use safe DOM manipulation instead of document.write
  doc.open();
  doc.write('<!DOCTYPE html><html><head><title>Document</title></head><body></body></html>');
  doc.close();
  
  // Add styles safely
  const style = doc.createElement('style');
  style.textContent = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
           line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 40px 20px; }
    h1 { font-size: 2rem; margin-bottom: 1rem; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; }
    /* ... other styles ... */
  `;
  doc.head.appendChild(style);
  
  // Add sanitized content
  doc.body.innerHTML = sanitizedContent;
  
  // Resource cleanup
  printWindow.addEventListener('beforeunload', () => {
    printWindow.close();
  });
  
  printWindow.print();
  onClose();
};
```

**1.2 Chat Export Security Fix**

```javascript
// client/src/api/endpoints/apps.js
import DOMPurify from 'dompurify';

const formatContent = content => {
  if (!content) return '';
  
  // SECURITY: Apply basic markdown formatting then sanitize
  const formatted = content
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
    
  // SECURITY: Sanitize the result
  return DOMPurify.sanitize(formatted, {
    ALLOWED_TAGS: ['strong', 'em', 'code', 'p', 'br'],
    ALLOWED_ATTR: []
  });
};
```

#### Testing

```javascript
// tests/security-patches.test.js
describe('PDF Export Security Patches', () => {
  test('Canvas export sanitizes malicious content', () => {
    const maliciousContent = '<script>alert("XSS")</script><p>Safe content</p>';
    // Test implementation
  });
  
  test('Chat formatContent prevents HTML injection', () => {
    const maliciousMarkdown = '**<script>alert("XSS")</script>**';
    const result = formatContent(maliciousMarkdown);
    expect(result).not.toContain('<script>');
  });
});
```

#### Validation Criteria
- [ ] XSS vulnerabilities eliminated
- [ ] Existing functionality preserved
- [ ] Security tests pass
- [ ] No breaking changes to UI

---

## Phase 1: Core Infrastructure (Weeks 1-4)

### 🏗️ Foundation Setup

**Objective**: Create the core service architecture with security framework

#### Deliverables

1. **Base Service Classes**
2. **TypeScript Interfaces**
3. **Security Framework**
4. **Configuration System**

#### File Structure

```
client/src/services/pdf/
├── index.js                    # Main export
├── PDFExportService.js         # Orchestrator service
├── types/
│   ├── index.js               # Type definitions
│   └── interfaces.js          # Core interfaces
├── security/
│   ├── ValidationService.js   # Input validation
│   ├── SanitizationService.js # Content sanitization
│   └── SecurityPolicy.js      # CSP and security rules
├── config/
│   ├── PDFConfig.js           # Configuration constants
│   └── templates.js           # Template definitions
├── processors/                 # Content processors (Phase 2)
├── generators/                 # PDF generators (Phase 2)
└── utils/
    ├── ResourceManager.js     # Memory/resource cleanup
    └── ErrorHandler.js        # Centralized error handling
```

#### Implementation

**1.1 Core Types and Interfaces**

```javascript
// client/src/services/pdf/types/interfaces.js

/**
 * Core PDF export request interface
 * @typedef {Object} PDFExportRequest
 * @property {string} content - Content to export
 * @property {ContentType} contentType - Type of content
 * @property {PDFTemplate} template - Template configuration
 * @property {ExportOptions} options - Export options
 * @property {SecurityConfig} security - Security settings
 */

/**
 * Content types supported by the PDF export system
 * @enum {string}
 */
export const ContentType = {
  HTML: 'html',
  MARKDOWN: 'markdown',
  SVG: 'svg',
  CANVAS: 'canvas',
  CHAT_CONVERSATION: 'chat_conversation',
  MERMAID_DIAGRAM: 'mermaid_diagram'
};

/**
 * PDF template configuration
 * @typedef {Object} PDFTemplate
 * @property {string} id - Template identifier
 * @property {string} name - Display name
 * @property {Object} styles - CSS styles
 * @property {Object} layout - Layout configuration
 * @property {WatermarkConfig} watermark - Watermark settings
 */

/**
 * Export options
 * @typedef {Object} ExportOptions
 * @property {string} filename - Output filename
 * @property {string} format - Output format (pdf, png, etc.)
 * @property {Object} metadata - Document metadata
 * @property {boolean} includeTimestamp - Include timestamp
 * @property {QualitySettings} quality - Quality settings
 */

/**
 * Security configuration
 * @typedef {Object} SecurityConfig
 * @property {boolean} sanitizeContent - Enable content sanitization
 * @property {string[]} allowedTags - Allowed HTML tags
 * @property {string[]} allowedAttributes - Allowed HTML attributes
 * @property {number} maxContentSize - Maximum content size (bytes)
 * @property {number} timeout - Processing timeout (ms)
 */

/**
 * Quality settings for PDF generation
 * @typedef {Object} QualitySettings
 * @property {number} dpi - DPI for images
 * @property {string} compression - Compression level
 * @property {boolean} imageSmoothingEnabled - Image smoothing
 */

/**
 * Content processor interface
 * @interface ContentProcessor
 */
export class ContentProcessor {
  /**
   * @param {ContentType} type - Content type this processor handles
   */
  constructor(type) {
    this.type = type;
  }
  
  /**
   * Process content for PDF generation
   * @param {string} content - Raw content
   * @param {PDFTemplate} template - Template configuration
   * @param {ExportOptions} options - Export options
   * @returns {Promise<ProcessedContent>} Processed content ready for PDF generation
   */
  async process(content, template, options) {
    throw new Error('ContentProcessor.process must be implemented');
  }
  
  /**
   * Validate content before processing
   * @param {string} content - Content to validate
   * @param {SecurityConfig} security - Security configuration
   * @returns {ValidationResult} Validation result
   */
  validate(content, security) {
    throw new Error('ContentProcessor.validate must be implemented');
  }
}

/**
 * PDF generator interface
 * @interface PDFGenerator
 */
export class PDFGenerator {
  /**
   * @param {string} name - Generator name
   * @param {string[]} supportedTypes - Supported content types
   */
  constructor(name, supportedTypes) {
    this.name = name;
    this.supportedTypes = supportedTypes;
  }
  
  /**
   * Generate PDF from processed content
   * @param {ProcessedContent} content - Processed content
   * @param {ExportOptions} options - Export options
   * @returns {Promise<Blob>} Generated PDF blob
   */
  async generate(content, options) {
    throw new Error('PDFGenerator.generate must be implemented');
  }
  
  /**
   * Check if generator supports content type
   * @param {ContentType} type - Content type
   * @returns {boolean} Whether type is supported
   */
  supports(type) {
    return this.supportedTypes.includes(type);
  }
}
```

**1.2 Main PDF Export Service**

```javascript
// client/src/services/pdf/PDFExportService.js
import { ValidationService } from './security/ValidationService';
import { ResourceManager } from './utils/ResourceManager';
import { ErrorHandler } from './utils/ErrorHandler';
import { PDFConfig } from './config/PDFConfig';

/**
 * Centralized PDF Export Service
 * 
 * Orchestrates PDF generation with security, validation,
 * and resource management for all content types.
 * 
 * @example
 * const pdfService = new PDFExportService();
 * const blob = await pdfService.export({
 *   content: '<h1>Hello World</h1>',
 *   contentType: ContentType.HTML,
 *   template: 'professional',
 *   options: { filename: 'document.pdf' }
 * });
 */
export class PDFExportService {
  constructor(config = {}) {
    this.config = { ...PDFConfig.DEFAULT, ...config };
    this.processors = new Map();
    this.generators = new Map();
    this.templates = new Map();
    
    // Core services
    this.validator = new ValidationService(this.config.security);
    this.resourceManager = new ResourceManager(this.config.resources);
    this.errorHandler = new ErrorHandler(this.config.errors);
    
    // Initialize built-in components
    this._initializeBuiltInComponents();
  }
  
  /**
   * Main export method - processes any content type to PDF
   * 
   * @param {PDFExportRequest} request - Export request
   * @returns {Promise<Blob>} Generated PDF blob
   * @throws {PDFExportError} When export fails
   */
  async export(request) {
    const startTime = performance.now();
    let resourceHandle = null;
    
    try {
      // 1. Validate request
      this.validator.validateRequest(request);
      
      // 2. Acquire resources
      resourceHandle = await this.resourceManager.acquire(request);
      
      // 3. Get processor and generator
      const processor = this.getProcessor(request.contentType);
      const generator = this.getGenerator(request.contentType, request.options);
      
      // 4. Process content
      const processedContent = await processor.process(
        request.content,
        this.getTemplate(request.template),
        request.options
      );
      
      // 5. Generate PDF
      const pdfBlob = await generator.generate(processedContent, request.options);
      
      // 6. Log success metrics
      this._logMetrics({
        type: request.contentType,
        duration: performance.now() - startTime,
        size: pdfBlob.size,
        success: true
      });
      
      return pdfBlob;
      
    } catch (error) {
      // Handle and log error
      const wrappedError = this.errorHandler.handleError(error, request);
      
      this._logMetrics({
        type: request.contentType,
        duration: performance.now() - startTime,
        error: wrappedError.message,
        success: false
      });
      
      throw wrappedError;
      
    } finally {
      // Always clean up resources
      if (resourceHandle) {
        await this.resourceManager.release(resourceHandle);
      }
    }
  }
  
  /**
   * Register a content processor
   * @param {ContentProcessor} processor - Processor to register
   */
  registerProcessor(processor) {
    this.processors.set(processor.type, processor);
  }
  
  /**
   * Register a PDF generator
   * @param {PDFGenerator} generator - Generator to register
   */
  registerGenerator(generator) {
    this.generators.set(generator.name, generator);
  }
  
  /**
   * Register a template
   * @param {string} id - Template ID
   * @param {PDFTemplate} template - Template configuration
   */
  registerTemplate(id, template) {
    this.templates.set(id, template);
  }
  
  /**
   * Get appropriate processor for content type
   * @private
   */
  getProcessor(contentType) {
    const processor = this.processors.get(contentType);
    if (!processor) {
      throw new Error(`No processor registered for content type: ${contentType}`);
    }
    return processor;
  }
  
  /**
   * Get optimal generator for content type and options
   * @private
   */
  getGenerator(contentType, options) {
    // Generator selection logic based on content type and requirements
    for (const [name, generator] of this.generators) {
      if (generator.supports(contentType)) {
        return generator;
      }
    }
    throw new Error(`No generator available for content type: ${contentType}`);
  }
  
  /**
   * Get template by ID
   * @private
   */
  getTemplate(templateId) {
    const template = this.templates.get(templateId) || this.templates.get('default');
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    return template;
  }
  
  /**
   * Initialize built-in processors, generators, and templates
   * @private
   */
  _initializeBuiltInComponents() {
    // Will be implemented in Phase 2
  }
  
  /**
   * Log performance and usage metrics
   * @private
   */
  _logMetrics(metrics) {
    if (this.config.telemetry.enabled) {
      console.log('[PDFExportService]', metrics);
      // Could integrate with analytics service
    }
  }
}
```

**1.3 Security Framework**

```javascript
// client/src/services/pdf/security/ValidationService.js
import DOMPurify from 'dompurify';
import { z } from 'zod';

/**
 * Input validation and security service for PDF exports
 * 
 * Provides multi-layer validation:
 * 1. Schema validation (structure)
 * 2. Content sanitization (XSS prevention)  
 * 3. Resource limits (DoS prevention)
 */
export class ValidationService {
  constructor(securityConfig) {
    this.config = securityConfig;
    this.schemas = this._createValidationSchemas();
  }
  
  /**
   * Validate complete export request
   * @param {PDFExportRequest} request - Request to validate
   * @throws {ValidationError} When validation fails
   */
  validateRequest(request) {
    // 1. Schema validation
    const result = this.schemas.exportRequest.safeParse(request);
    if (!result.success) {
      throw new ValidationError('Invalid request structure', result.error);
    }
    
    // 2. Content size validation
    this._validateContentSize(request.content);
    
    // 3. Security validation
    this._validateSecurityRequirements(request);
  }
  
  /**
   * Sanitize content based on type and security policy
   * @param {string} content - Content to sanitize
   * @param {ContentType} type - Content type
   * @param {SecurityConfig} security - Security configuration
   * @returns {string} Sanitized content
   */
  sanitizeContent(content, type, security) {
    if (!security.sanitizeContent) {
      return content;
    }
    
    switch (type) {
      case ContentType.HTML:
        return DOMPurify.sanitize(content, {
          ALLOWED_TAGS: security.allowedTags,
          ALLOWED_ATTR: security.allowedAttributes,
          ALLOWED_URI_REGEXP: /^(?:(?:https?|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i
        });
        
      case ContentType.MARKDOWN:
        // Convert to HTML first, then sanitize
        const htmlContent = this._markdownToHtml(content);
        return this.sanitizeContent(htmlContent, ContentType.HTML, security);
        
      case ContentType.SVG:
        return DOMPurify.sanitize(content, {
          USE_PROFILES: { svg: true, svgFilters: true }
        });
        
      default:
        return content;
    }
  }
  
  /**
   * Create Zod validation schemas
   * @private
   */
  _createValidationSchemas() {
    const exportRequestSchema = z.object({
      content: z.string().min(1, 'Content cannot be empty'),
      contentType: z.enum(Object.values(ContentType)),
      template: z.string().optional().default('default'),
      options: z.object({
        filename: z.string().optional(),
        format: z.string().optional().default('pdf'),
        metadata: z.object({}).optional(),
        includeTimestamp: z.boolean().optional().default(false),
        quality: z.object({
          dpi: z.number().min(72).max(300).optional().default(150),
          compression: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).optional().default('MEDIUM'),
          imageSmoothingEnabled: z.boolean().optional().default(true)
        }).optional()
      }).optional().default({}),
      security: z.object({
        sanitizeContent: z.boolean().optional().default(true),
        allowedTags: z.array(z.string()).optional(),
        allowedAttributes: z.array(z.string()).optional(),
        maxContentSize: z.number().optional().default(5 * 1024 * 1024), // 5MB
        timeout: z.number().optional().default(30000) // 30s
      }).optional()
    });
    
    return {
      exportRequest: exportRequestSchema
    };
  }
  
  /**
   * Validate content size limits
   * @private
   */
  _validateContentSize(content) {
    const size = new Blob([content]).size;
    if (size > this.config.maxContentSize) {
      throw new ValidationError(
        `Content size ${size} exceeds maximum ${this.config.maxContentSize} bytes`
      );
    }
  }
  
  /**
   * Validate security requirements
   * @private
   */
  _validateSecurityRequirements(request) {
    // Check for potentially dangerous content patterns
    const dangerousPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      /<iframe\b/gi,
      /<object\b/gi,
      /<embed\b/gi
    ];
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(request.content)) {
        throw new ValidationError(
          'Content contains potentially dangerous elements'
        );
      }
    }
  }
  
  /**
   * Convert markdown to HTML (placeholder)
   * @private
   */
  _markdownToHtml(markdown) {
    // Would use a proper markdown parser like marked
    return markdown;
  }
}

/**
 * Custom validation error
 */
export class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}
```

**1.4 Configuration System**

```javascript
// client/src/services/pdf/config/PDFConfig.js

/**
 * Centralized configuration for PDF export system
 */
export const PDFConfig = {
  // Default configuration
  DEFAULT: {
    // Security settings
    security: {
      sanitizeContent: true,
      allowedTags: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'br', 'div', 'span',
        'strong', 'em', 'b', 'i', 'u',
        'ul', 'ol', 'li',
        'blockquote', 'code', 'pre',
        'table', 'thead', 'tbody', 'tr', 'td', 'th',
        'img', 'svg', 'path', 'circle', 'rect', 'line'
      ],
      allowedAttributes: [
        'class', 'id', 'style',
        'src', 'alt', 'width', 'height',
        'href', 'title',
        'colspan', 'rowspan'
      ],
      maxContentSize: 5 * 1024 * 1024, // 5MB
      timeout: 30000 // 30 seconds
    },
    
    // Resource management
    resources: {
      maxConcurrentExports: 3,
      memoryLimit: 100 * 1024 * 1024, // 100MB
      cleanupInterval: 60000, // 1 minute
      retentionTime: 300000 // 5 minutes
    },
    
    // Quality settings
    quality: {
      defaultDPI: 150,
      maxDPI: 300,
      compression: 'MEDIUM',
      imageSmoothingEnabled: true,
      scaleFactor: 2
    },
    
    // Template settings
    templates: {
      default: 'professional',
      path: '/templates/',
      cacheEnabled: true
    },
    
    // Error handling
    errors: {
      logErrors: true,
      includeStack: false, // Set to true in development
      userFriendlyMessages: true
    },
    
    // Telemetry
    telemetry: {
      enabled: true,
      includePerformanceMetrics: true,
      includeUsageStats: true
    }
  },
  
  // Font configurations
  FONTS: {
    primary: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    code: 'Monaco, Menlo, "Courier New", Consolas, monospace',
    fallback: 'Arial, sans-serif'
  },
  
  // Dimension constants
  DIMENSIONS: {
    maxWidth: 800,
    margin: 20,
    padding: 40,
    lineHeight: 1.6
  },
  
  // Color palette
  COLORS: {
    text: '#1f2937',
    heading: '#111827',
    border: '#e5e7eb',
    background: '#ffffff',
    accent: '#6366f1',
    muted: '#6b7280'
  }
};
```

#### Testing Strategy

```javascript
// tests/pdf/PDFExportService.test.js
import { PDFExportService } from '../src/services/pdf/PDFExportService';
import { ContentType } from '../src/services/pdf/types/interfaces';

describe('PDFExportService', () => {
  let pdfService;
  
  beforeEach(() => {
    pdfService = new PDFExportService();
  });
  
  describe('Security', () => {
    test('sanitizes malicious HTML content', async () => {
      const maliciousContent = '<script>alert("XSS")</script><p>Safe content</p>';
      
      const request = {
        content: maliciousContent,
        contentType: ContentType.HTML,
        template: 'default'
      };
      
      // Should not throw, should sanitize
      await expect(pdfService.export(request)).resolves.toBeDefined();
    });
    
    test('rejects oversized content', async () => {
      const largeContent = 'x'.repeat(10 * 1024 * 1024); // 10MB
      
      const request = {
        content: largeContent,
        contentType: ContentType.HTML,
        template: 'default'
      };
      
      await expect(pdfService.export(request)).rejects.toThrow('Content size');
    });
  });
  
  describe('Resource Management', () => {
    test('cleans up resources after export', async () => {
      const request = {
        content: '<p>Test content</p>',
        contentType: ContentType.HTML,
        template: 'default'
      };
      
      const initialMemory = performance.memory?.usedJSHeapSize || 0;
      await pdfService.export(request);
      
      // Allow cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const finalMemory = performance.memory?.usedJSHeapSize || 0;
      expect(finalMemory).toBeLessThanOrEqual(initialMemory + 1024 * 1024); // 1MB tolerance
    });
  });
});
```

#### Validation Criteria

- [ ] Core service classes created and tested
- [ ] Security framework validates and sanitizes input
- [ ] Resource management prevents memory leaks
- [ ] Configuration system is flexible and extensible
- [ ] TypeScript interfaces provide type safety
- [ ] Error handling is comprehensive
- [ ] Unit tests achieve 80%+ coverage

---

## Phase 2: Content Processors (Weeks 4-6)

### 🎨 Processor Implementation

**Objective**: Create specialized processors for each content type

#### Deliverables

1. **HTML Content Processor**
2. **SVG Content Processor** 
3. **Canvas Content Processor**
4. **Chat Conversation Processor**

#### Implementation

**2.1 HTML Content Processor**

```javascript
// client/src/services/pdf/processors/HTMLProcessor.js
import { ContentProcessor, ContentType } from '../types/interfaces';
import { ValidationService } from '../security/ValidationService';

/**
 * Processes HTML content for PDF generation
 * 
 * Features:
 * - HTML sanitization and validation
 * - CSS processing and optimization
 * - Image handling and optimization
 * - Typography and layout improvements
 */
export class HTMLProcessor extends ContentProcessor {
  constructor(config = {}) {
    super(ContentType.HTML);
    this.config = config;
    this.validator = new ValidationService(config.security);
  }
  
  /**
   * Process HTML content for PDF generation
   * @param {string} content - Raw HTML content
   * @param {PDFTemplate} template - Template configuration
   * @param {ExportOptions} options - Export options
   * @returns {Promise<ProcessedContent>} Processed content
   */
  async process(content, template, options) {
    try {
      // 1. Validate and sanitize content
      const sanitizedContent = this.validator.sanitizeContent(
        content, 
        ContentType.HTML, 
        options.security || {}
      );
      
      // 2. Apply template styling
      const styledContent = this._applyTemplateStyles(sanitizedContent, template);
      
      // 3. Optimize for PDF rendering
      const optimizedContent = this._optimizeForPDF(styledContent, options);
      
      // 4. Handle images and media
      const processedContent = await this._processImages(optimizedContent, options);
      
      return {
        content: processedContent,
        type: ContentType.HTML,
        metadata: {
          wordCount: this._countWords(sanitizedContent),
          hasImages: this._hasImages(processedContent),
          estimatedPages: this._estimatePages(processedContent)
        }
      };
      
    } catch (error) {
      throw new Error(`HTML processing failed: ${error.message}`);
    }
  }
  
  /**
   * Validate HTML content structure
   * @param {string} content - Content to validate
   * @param {SecurityConfig} security - Security configuration
   * @returns {ValidationResult} Validation result
   */
  validate(content, security) {
    try {
      // Check for valid HTML structure
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, 'text/html');
      
      const hasErrors = doc.querySelector('parsererror') !== null;
      if (hasErrors) {
        return {
          valid: false,
          errors: ['Invalid HTML structure']
        };
      }
      
      // Additional validation rules
      const warnings = [];
      if (content.length > 1024 * 1024) { // 1MB
        warnings.push('Large HTML content may impact performance');
      }
      
      return {
        valid: true,
        warnings
      };
      
    } catch (error) {
      return {
        valid: false,
        errors: [error.message]
      };
    }
  }
  
  /**
   * Apply template styles to HTML content
   * @private
   */
  _applyTemplateStyles(content, template) {
    const styles = template.styles || {};
    
    // Create CSS string from template styles
    const css = Object.entries(styles)
      .map(([selector, rules]) => {
        const ruleString = Object.entries(rules)
          .map(([property, value]) => `${property}: ${value}`)
          .join('; ');
        return `${selector} { ${ruleString} }`;
      })
      .join('\n');
    
    // Wrap content with styled HTML
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>PDF Export</title>
          <style>
            ${css}
            @media print {
              body { margin: 0; }
              .no-print { display: none !important; }
            }
          </style>
        </head>
        <body>
          ${content}
        </body>
      </html>
    `;
  }
  
  /**
   * Optimize HTML for PDF rendering
   * @private
   */
  _optimizeForPDF(content, options) {
    let optimized = content;
    
    // Remove interactive elements that don't work in PDF
    optimized = optimized.replace(/<button[^>]*>.*?<\/button>/gi, '');
    optimized = optimized.replace(/<input[^>]*\/?>/gi, '');
    optimized = optimized.replace(/<form[^>]*>.*?<\/form>/gi, '');
    
    // Improve table rendering
    optimized = optimized.replace(/<table/gi, '<table style="page-break-inside: avoid;"');
    
    // Add page break hints for long content
    if (options.addPageBreaks) {
      optimized = this._addPageBreakHints(optimized);
    }
    
    return optimized;
  }
  
  /**
   * Process images for PDF compatibility
   * @private
   */
  async _processImages(content, options) {
    // Find all images
    const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
    const images = [];
    let match;
    
    while ((match = imgRegex.exec(content)) !== null) {
      images.push({
        fullMatch: match[0],
        src: match[1]
      });
    }
    
    // Process each image
    let processedContent = content;
    for (const img of images) {
      try {
        const processedImg = await this._processImage(img.src, options);
        processedContent = processedContent.replace(img.fullMatch, processedImg);
      } catch (error) {
        console.warn('Failed to process image:', img.src, error);
        // Keep original image tag
      }
    }
    
    return processedContent;
  }
  
  /**
   * Process individual image
   * @private
   */
  async _processImage(src, options) {
    // Handle data URLs
    if (src.startsWith('data:')) {
      return `<img src="${src}" style="max-width: 100%; height: auto;">`;
    }
    
    // Handle external URLs - convert to data URL for PDF embedding
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const dataUrl = await this._blobToDataURL(blob);
      return `<img src="${dataUrl}" style="max-width: 100%; height: auto;">`;
    } catch {
      // Fallback to original src
      return `<img src="${src}" style="max-width: 100%; height: auto;">`;
    }
  }
  
  /**
   * Convert blob to data URL
   * @private
   */
  _blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  
  /**
   * Count words in HTML content
   * @private
   */
  _countWords(content) {
    const text = content.replace(/<[^>]*>/g, '');
    return text.trim().split(/\s+/).length;
  }
  
  /**
   * Check if content has images
   * @private
   */
  _hasImages(content) {
    return /<img[^>]+src/i.test(content);
  }
  
  /**
   * Estimate number of pages
   * @private
   */
  _estimatePages(content) {
    const wordCount = this._countWords(content);
    const wordsPerPage = 500; // Rough estimate
    return Math.ceil(wordCount / wordsPerPage);
  }
  
  /**
   * Add page break hints for long content
   * @private
   */
  _addPageBreakHints(content) {
    // Add page breaks before major headings
    content = content.replace(/<h1/gi, '<div style="page-break-before: always;"></div><h1');
    
    return content;
  }
}
```

**2.2 SVG Content Processor**

```javascript
// client/src/services/pdf/processors/SVGProcessor.js
import { ContentProcessor, ContentType } from '../types/interfaces';

/**
 * Processes SVG content for PDF generation
 * 
 * Features:
 * - SVG validation and sanitization
 * - Viewbox optimization for PDF layout
 * - Font embedding and text rendering
 * - Color space optimization
 */
export class SVGProcessor extends ContentProcessor {
  constructor(config = {}) {
    super(ContentType.SVG);
    this.config = config;
  }
  
  /**
   * Process SVG content for PDF generation
   * @param {string} content - Raw SVG content
   * @param {PDFTemplate} template - Template configuration
   * @param {ExportOptions} options - Export options
   * @returns {Promise<ProcessedContent>} Processed content
   */
  async process(content, template, options) {
    try {
      // 1. Parse and validate SVG
      const svgDoc = this._parseSVG(content);
      
      // 2. Optimize for PDF rendering
      const optimizedSVG = this._optimizeForPDF(svgDoc, options);
      
      // 3. Handle fonts and text
      const processedSVG = await this._processText(optimizedSVG, options);
      
      // 4. Apply template styling
      const styledSVG = this._applyTemplateStyles(processedSVG, template);
      
      return {
        content: styledSVG,
        type: ContentType.SVG,
        metadata: {
          dimensions: this._getDimensions(svgDoc),
          hasText: this._hasText(svgDoc),
          complexity: this._calculateComplexity(svgDoc)
        }
      };
      
    } catch (error) {
      throw new Error(`SVG processing failed: ${error.message}`);
    }
  }
  
  /**
   * Parse SVG content into DOM
   * @private
   */
  _parseSVG(content) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'image/svg+xml');
    
    // Check for parser errors
    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      throw new Error('Invalid SVG content');
    }
    
    return doc;
  }
  
  /**
   * Optimize SVG for PDF rendering
   * @private
   */
  _optimizeForPDF(svgDoc, options) {
    const svg = svgDoc.documentElement;
    
    // Ensure viewBox is set for proper scaling
    if (!svg.getAttribute('viewBox')) {
      const width = svg.getAttribute('width') || '100';
      const height = svg.getAttribute('height') || '100';
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    
    // Set dimensions for PDF
    const maxWidth = options.maxWidth || 800;
    const maxHeight = options.maxHeight || 600;
    
    svg.setAttribute('width', maxWidth);
    svg.setAttribute('height', maxHeight);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    
    return new XMLSerializer().serializeToString(svgDoc);
  }
  
  /**
   * Process text elements in SVG
   * @private
   */
  async _processText(svgContent, options) {
    // For now, return as-is
    // Could implement font subsetting or text-to-path conversion
    return svgContent;
  }
  
  /**
   * Apply template styles to SVG
   * @private
   */
  _applyTemplateStyles(svgContent, template) {
    if (!template.svgStyles) {
      return svgContent;
    }
    
    // Apply CSS styles to SVG elements
    // This is a simplified implementation
    return svgContent;
  }
  
  /**
   * Get SVG dimensions
   * @private
   */
  _getDimensions(svgDoc) {
    const svg = svgDoc.documentElement;
    return {
      width: svg.getAttribute('width'),
      height: svg.getAttribute('height'),
      viewBox: svg.getAttribute('viewBox')
    };
  }
  
  /**
   * Check if SVG contains text elements
   * @private
   */
  _hasText(svgDoc) {
    return svgDoc.querySelectorAll('text, tspan').length > 0;
  }
  
  /**
   * Calculate SVG complexity score
   * @private
   */
  _calculateComplexity(svgDoc) {
    const elements = svgDoc.querySelectorAll('*').length;
    const paths = svgDoc.querySelectorAll('path').length;
    const groups = svgDoc.querySelectorAll('g').length;
    
    return {
      totalElements: elements,
      paths,
      groups,
      score: elements + (paths * 2) + (groups * 0.5)
    };
  }
}
```

**2.3 Chat Conversation Processor**

```javascript
// client/src/services/pdf/processors/ChatProcessor.js
import { ContentProcessor, ContentType } from '../types/interfaces';
import { HTMLProcessor } from './HTMLProcessor';

/**
 * Processes chat conversations for PDF generation
 * 
 * Features:
 * - Message formatting and threading
 * - Metadata inclusion (timestamps, models, settings)
 * - Code syntax highlighting
 * - Message role styling (user vs assistant)
 */
export class ChatProcessor extends ContentProcessor {
  constructor(config = {}) {
    super(ContentType.CHAT_CONVERSATION);
    this.config = config;
    this.htmlProcessor = new HTMLProcessor(config);
  }
  
  /**
   * Process chat conversation for PDF generation
   * @param {Array} messages - Chat messages array
   * @param {PDFTemplate} template - Template configuration
   * @param {ExportOptions} options - Export options
   * @returns {Promise<ProcessedContent>} Processed content
   */
  async process(messages, template, options) {
    try {
      // 1. Filter and prepare messages
      const filteredMessages = this._filterMessages(messages, options);
      
      // 2. Generate HTML from messages
      const htmlContent = this._messagesToHTML(filteredMessages, options);
      
      // 3. Add metadata header
      const contentWithMeta = this._addMetadata(htmlContent, options);
      
      // 4. Process through HTML processor
      return await this.htmlProcessor.process(contentWithMeta, template, options);
      
    } catch (error) {
      throw new Error(`Chat processing failed: ${error.message}`);
    }
  }
  
  /**
   * Filter messages based on options
   * @private
   */
  _filterMessages(messages, options) {
    let filtered = messages;
    
    // Remove greeting messages
    filtered = filtered.filter(m => !m.isGreeting);
    
    // Filter by date range if specified
    if (options.dateRange) {
      const { start, end } = options.dateRange;
      filtered = filtered.filter(m => {
        const msgDate = new Date(m.timestamp);
        return msgDate >= start && msgDate <= end;
      });
    }
    
    // Limit number of messages if specified
    if (options.maxMessages) {
      filtered = filtered.slice(-options.maxMessages);
    }
    
    return filtered;
  }
  
  /**
   * Convert messages array to HTML
   * @private
   */
  _messagesToHTML(messages, options) {
    const htmlMessages = messages.map(message => {
      return this._messageToHTML(message, options);
    });
    
    return `
      <div class="chat-conversation">
        ${htmlMessages.join('\n')}
      </div>
    `;
  }
  
  /**
   * Convert single message to HTML
   * @private
   */
  _messageToHTML(message, options) {
    const roleClass = message.role === 'user' ? 'user-message' : 'assistant-message';
    const timestamp = options.includeTimestamps 
      ? `<div class="timestamp">${new Date(message.timestamp).toLocaleString()}</div>`
      : '';
    
    // Process message content
    let content = message.content || '';
    
    // Apply markdown formatting if needed
    if (options.processMarkdown) {
      content = this._processMarkdown(content);
    }
    
    // Highlight code blocks
    if (options.highlightCode) {
      content = this._highlightCodeBlocks(content);
    }
    
    return `
      <div class="message ${roleClass}">
        <div class="message-header">
          <span class="role">${message.role}</span>
          ${timestamp}
        </div>
        <div class="message-content">
          ${content}
        </div>
      </div>
    `;
  }
  
  /**
   * Add metadata header to content
   * @private
   */
  _addMetadata(content, options) {
    if (!options.includeMetadata) {
      return content;
    }
    
    const metadata = options.metadata || {};
    const metadataHTML = `
      <div class="export-metadata">
        <h1>Chat Export</h1>
        <div class="metadata-grid">
          ${metadata.model ? `<div><strong>Model:</strong> ${metadata.model}</div>` : ''}
          ${metadata.style ? `<div><strong>Style:</strong> ${metadata.style}</div>` : ''}
          ${metadata.temperature ? `<div><strong>Temperature:</strong> ${metadata.temperature}</div>` : ''}
          ${metadata.appName ? `<div><strong>App:</strong> ${metadata.appName}</div>` : ''}
          <div><strong>Export Date:</strong> ${new Date().toLocaleString()}</div>
        </div>
      </div>
      <hr class="metadata-separator">
    `;
    
    return metadataHTML + content;
  }
  
  /**
   * Process markdown in message content
   * @private
   */
  _processMarkdown(content) {
    // Basic markdown processing
    // In a real implementation, use a proper markdown parser
    return content
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/\n/g, '<br>');
  }
  
  /**
   * Highlight code blocks in content
   * @private
   */
  _highlightCodeBlocks(content) {
    // Simple syntax highlighting
    // In a real implementation, use a proper syntax highlighter
    return content.replace(
      /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
      '<pre class="code-block"><code>$1</code></pre>'
    );
  }
}
```

#### Testing Strategy

```javascript
// tests/pdf/processors/HTMLProcessor.test.js
describe('HTMLProcessor', () => {
  let processor;
  
  beforeEach(() => {
    processor = new HTMLProcessor();
  });
  
  test('sanitizes malicious HTML', async () => {
    const maliciousHTML = '<script>alert("XSS")</script><p>Safe content</p>';
    const template = { styles: {} };
    const options = { security: { sanitizeContent: true } };
    
    const result = await processor.process(maliciousHTML, template, options);
    
    expect(result.content).not.toContain('<script>');
    expect(result.content).toContain('Safe content');
  });
  
  test('applies template styles correctly', async () => {
    const content = '<h1>Title</h1><p>Content</p>';
    const template = {
      styles: {
        'h1': { 'color': '#333', 'font-size': '2rem' },
        'p': { 'color': '#666' }
      }
    };
    
    const result = await processor.process(content, template, {});
    
    expect(result.content).toContain('h1 { color: #333; font-size: 2rem }');
    expect(result.content).toContain('p { color: #666 }');
  });
  
  test('estimates page count accurately', async () => {
    const longContent = '<p>' + 'word '.repeat(1000) + '</p>';
    const result = await processor.process(longContent, {}, {});
    
    expect(result.metadata.estimatedPages).toBeGreaterThan(1);
  });
});
```

#### Validation Criteria

- [ ] All content processors created and tested
- [ ] HTML processor sanitizes content and applies templates
- [ ] SVG processor handles viewBox and optimization
- [ ] Canvas processor manages resource cleanup
- [ ] Chat processor formats conversations properly
- [ ] Unit tests achieve 85%+ coverage for each processor
- [ ] Integration tests verify end-to-end processing

---

## Phase 3: React Integration (Weeks 6-9)

### ⚛️ Component Integration

**Objective**: Create React components and migrate existing implementations

#### Deliverables

1. **React Hooks for PDF Export**
2. **Unified Export Components**
3. **Migration Adapters**
4. **Feature Flag Integration**

#### Implementation

**3.1 PDF Export Hook**

```javascript
// client/src/hooks/usePDFExport.js
import { useState, useCallback, useRef } from 'react';
import { PDFExportService } from '../services/pdf';
import { ContentType } from '../services/pdf/types/interfaces';
import { useTranslation } from 'react-i18next';

/**
 * React hook for PDF export functionality
 * 
 * @param {Object} config - Configuration options
 * @returns {Object} Export functions and state
 */
export const usePDFExport = (config = {}) => {
  const { t } = useTranslation();
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [error, setError] = useState(null);
  const serviceRef = useRef(null);
  
  // Initialize service lazily
  const getService = useCallback(() => {
    if (!serviceRef.current) {
      serviceRef.current = new PDFExportService(config);
    }
    return serviceRef.current;
  }, [config]);
  
  /**
   * Export content to PDF
   * @param {Object} exportRequest - Export request parameters
   * @returns {Promise<Blob>} PDF blob
   */
  const exportToPDF = useCallback(async (exportRequest) => {
    setIsExporting(true);
    setError(null);
    setExportProgress(0);
    
    try {
      const service = getService();
      
      // Create progress simulation (real progress would need service support)
      const progressInterval = setInterval(() => {
        setExportProgress(prev => Math.min(prev + 10, 90));
      }, 200);
      
      const pdfBlob = await service.export(exportRequest);
      
      clearInterval(progressInterval);
      setExportProgress(100);
      
      // Trigger download
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportRequest.options?.filename || 'export.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      return pdfBlob;
      
    } catch (err) {
      setError(err.message || t('export.error.generic'));
      throw err;
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  }, [getService, t]);
  
  /**
   * Export HTML content
   */
  const exportHTML = useCallback((content, options = {}) => {
    return exportToPDF({
      content,
      contentType: ContentType.HTML,
      template: options.template || 'default',
      options: {
        filename: options.filename || 'document.pdf',
        includeTimestamp: options.includeTimestamp || false,
        ...options
      }
    });
  }, [exportToPDF]);
  
  /**
   * Export chat conversation
   */
  const exportChat = useCallback((messages, metadata = {}, options = {}) => {
    return exportToPDF({
      content: messages,
      contentType: ContentType.CHAT_CONVERSATION,
      template: options.template || 'professional',
      options: {
        filename: options.filename || 'chat-export.pdf',
        includeMetadata: true,
        includeTimestamps: options.includeTimestamps || true,
        processMarkdown: true,
        highlightCode: true,
        metadata,
        ...options
      }
    });
  }, [exportToPDF]);
  
  /**
   * Export SVG content (e.g., Mermaid diagrams)
   */
  const exportSVG = useCallback((svgContent, options = {}) => {
    return exportToPDF({
      content: svgContent,
      contentType: ContentType.SVG,
      template: options.template || 'minimal',
      options: {
        filename: options.filename || 'diagram.pdf',
        maxWidth: options.maxWidth || 800,
        maxHeight: options.maxHeight || 600,
        ...options
      }
    });
  }, [exportToPDF]);
  
  /**
   * Clear current error
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);
  
  /**
   * Cancel current export (if possible)
   */
  const cancelExport = useCallback(() => {
    // TODO: Implement cancellation if service supports it
    setIsExporting(false);
    setExportProgress(0);
  }, []);
  
  return {
    // Export functions
    exportToPDF,
    exportHTML,
    exportChat,
    exportSVG,
    
    // State
    isExporting,
    exportProgress,
    error,
    
    // Actions
    clearError,
    cancelExport
  };
};
```

**3.2 Unified Export Menu Component**

```javascript
// client/src/components/pdf/PDFExportMenu.jsx
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../shared/components/Icon';
import { usePDFExport } from '../../hooks/usePDFExport';

/**
 * Unified PDF export menu component
 * 
 * Replaces all existing export menus with consistent UI
 * and centralized PDF generation logic.
 */
const PDFExportMenu = ({ 
  content, 
  contentType, 
  onClose, 
  defaultFilename = 'export.pdf',
  showTemplateOptions = true,
  showAdvancedOptions = false 
}) => {
  const { t } = useTranslation();
  const { exportToPDF, isExporting, exportProgress, error, clearError } = usePDFExport();
  
  const [selectedTemplate, setSelectedTemplate] = useState('professional');
  const [filename, setFilename] = useState(defaultFilename);
  const [includeTimestamp, setIncludeTimestamp] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  
  const templates = [
    { id: 'professional', name: t('export.template.professional') },
    { id: 'minimal', name: t('export.template.minimal') },
    { id: 'default', name: t('export.template.default') }
  ];
  
  const handleExport = async () => {
    try {
      clearError();
      
      await exportToPDF({
        content,
        contentType,
        template: selectedTemplate,
        options: {
          filename,
          includeTimestamp
        }
      });
      
      onClose?.();
      
    } catch (err) {
      console.error('Export failed:', err);
      // Error is handled by the hook
    }
  };
  
  const formatFilename = (name) => {
    if (includeTimestamp) {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const [baseName, ext] = name.split('.');
      return `${baseName}_${timestamp}.${ext}`;
    }
    return name;
  };
  
  return (
    <div className="bg-white rounded-lg shadow-lg border p-4 min-w-80">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">
          {t('export.title')}
        </h3>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-100 rounded"
        >
          <Icon name="X" size={20} />
        </button>
      </div>
      
      {/* Template Selection */}
      {showTemplateOptions && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('export.template.label')}
          </label>
          <select
            value={selectedTemplate}
            onChange={(e) => setSelectedTemplate(e.target.value)}
            className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            {templates.map(template => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </div>
      )}
      
      {/* Filename Input */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {t('export.filename.label')}
        </label>
        <input
          type="text"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="document.pdf"
        />
        <p className="text-xs text-gray-500 mt-1">
          {t('export.filename.preview')}: {formatFilename(filename)}
        </p>
      </div>
      
      {/* Advanced Options */}
      {showAdvancedOptions && (
        <div className="mb-4">
          <button
            onClick={() => setShowOptions(!showOptions)}
            className="flex items-center text-sm text-blue-600 hover:text-blue-800"
          >
            <Icon name={showOptions ? 'ChevronUp' : 'ChevronDown'} size={16} className="mr-1" />
            {t('export.options.advanced')}
          </button>
          
          {showOptions && (
            <div className="mt-2 p-3 bg-gray-50 rounded-md">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={includeTimestamp}
                  onChange={(e) => setIncludeTimestamp(e.target.checked)}
                  className="mr-2"
                />
                <span className="text-sm text-gray-700">
                  {t('export.options.timestamp')}
                </span>
              </label>
            </div>
          )}
        </div>
      )}
      
      {/* Error Display */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
          <div className="flex items-center">
            <Icon name="AlertCircle" size={16} className="text-red-500 mr-2" />
            <span className="text-sm text-red-700">{error}</span>
          </div>
        </div>
      )}
      
      {/* Progress Bar */}
      {isExporting && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-sm text-gray-600 mb-1">
            <span>{t('export.progress.generating')}</span>
            <span>{exportProgress}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${exportProgress}%` }}
            />
          </div>
        </div>
      )}
      
      {/* Actions */}
      <div className="flex space-x-3">
        <button
          onClick={handleExport}
          disabled={isExporting}
          className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
        >
          {isExporting ? (
            <>
              <Icon name="Loader" size={16} className="animate-spin mr-2" />
              {t('export.button.generating')}
            </>
          ) : (
            <>
              <Icon name="Download" size={16} className="mr-2" />
              {t('export.button.export')}
            </>
          )}
        </button>
        
        <button
          onClick={onClose}
          className="px-4 py-2 text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
};

export default PDFExportMenu;
```

**3.3 Migration Adapter Components**

```javascript
// client/src/components/pdf/adapters/ChatExportAdapter.jsx
import React from 'react';
import PDFExportMenu from '../PDFExportMenu';
import { ContentType } from '../../../services/pdf/types/interfaces';

/**
 * Adapter component for chat export menu
 * 
 * Provides backward compatibility while using new PDF service
 */
const ChatExportAdapter = ({ messages = [], settings = {}, onClose, appId, chatId }) => {
  // Prepare content for chat processor
  const content = messages.filter(m => !m.isGreeting);
  
  // Build metadata from settings
  const metadata = {
    model: settings.model,
    style: settings.style,
    outputFormat: settings.outputFormat,
    temperature: settings.temperature,
    variables: settings.variables,
    appId,
    chatId
  };
  
  return (
    <PDFExportMenu
      content={content}
      contentType={ContentType.CHAT_CONVERSATION}
      onClose={onClose}
      defaultFilename="chat-export.pdf"
      showTemplateOptions={true}
      showAdvancedOptions={true}
      metadata={metadata}
    />
  );
};

export default ChatExportAdapter;
```

```javascript
// client/src/components/pdf/adapters/CanvasExportAdapter.jsx
import React from 'react';
import PDFExportMenu from '../PDFExportMenu';
import { ContentType } from '../../../services/pdf/types/interfaces';

/**
 * Adapter component for canvas export menu
 * 
 * Provides backward compatibility for canvas content export
 */
const CanvasExportAdapter = ({ content, onClose }) => {
  return (
    <PDFExportMenu
      content={content}
      contentType={ContentType.HTML}
      onClose={onClose}
      defaultFilename="canvas-export.pdf"
      showTemplateOptions={true}
      showAdvancedOptions={false}
    />
  );
};

export default CanvasExportAdapter;
```

**3.4 Feature Flag Integration**

```javascript
// client/src/hooks/usePDFExportWithFeatureFlag.js
import { usePDFExport } from './usePDFExport';
import { usePlatformConfig } from '../shared/contexts/PlatformConfigContext';

/**
 * Enhanced PDF export hook with feature flag support
 * 
 * Allows gradual rollout of new PDF export system
 */
export const usePDFExportWithFeatureFlag = (config = {}) => {
  const { platformConfig } = usePlatformConfig();
  const pdfExport = usePDFExport(config);
  
  // Check if new PDF export is enabled
  const isNewPDFExportEnabled = platformConfig?.features?.centralizedPDFExport?.enabled || false;
  
  return {
    ...pdfExport,
    isNewPDFExportEnabled,
    
    // Wrapper functions that respect feature flag
    exportToPDF: isNewPDFExportEnabled ? pdfExport.exportToPDF : null,
    exportHTML: isNewPDFExportEnabled ? pdfExport.exportHTML : null,
    exportChat: isNewPDFExportEnabled ? pdfExport.exportChat : null,
    exportSVG: isNewPDFExportEnabled ? pdfExport.exportSVG : null
  };
};
```

#### Migration Strategy

**3.5 Step-by-Step Component Migration**

```javascript
// Migration Plan for ExportConversationMenu.jsx

// Phase 1: Feature Flag Integration
// Add feature flag check to existing component
const ExportConversationMenu = ({ messages, settings, onClose, appId, chatId }) => {
  const { platformConfig } = usePlatformConfig();
  const isNewExportEnabled = platformConfig?.features?.centralizedPDFExport?.enabled;
  
  if (isNewExportEnabled) {
    return (
      <ChatExportAdapter 
        messages={messages}
        settings={settings}
        onClose={onClose}
        appId={appId}
        chatId={chatId}
      />
    );
  }
  
  // Existing implementation
  return (
    <div>
      {/* Original export menu code */}
    </div>
  );
};

// Phase 2: A/B Testing (Optional)
// Split traffic between old and new implementation

// Phase 3: Full Migration
// Remove feature flag and old implementation
const ExportConversationMenu = ({ messages, settings, onClose, appId, chatId }) => {
  return (
    <ChatExportAdapter 
      messages={messages}
      settings={settings}
      onClose={onClose}
      appId={appId}
      chatId={chatId}
    />
  );
};
```

#### Testing Strategy

```javascript
// tests/hooks/usePDFExport.test.js
import { renderHook, act } from '@testing-library/react';
import { usePDFExport } from '../../src/hooks/usePDFExport';
import { ContentType } from '../../src/services/pdf/types/interfaces';

describe('usePDFExport', () => {
  test('exports HTML content successfully', async () => {
    const { result } = renderHook(() => usePDFExport());
    
    await act(async () => {
      const blob = await result.current.exportHTML('<h1>Test</h1>', {
        filename: 'test.pdf'
      });
      
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/pdf');
    });
    
    expect(result.current.isExporting).toBe(false);
    expect(result.current.error).toBeNull();
  });
  
  test('handles export errors gracefully', async () => {
    const { result } = renderHook(() => usePDFExport());
    
    await act(async () => {
      try {
        await result.current.exportHTML('', {}); // Empty content should fail
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
    
    expect(result.current.error).toBeTruthy();
    expect(result.current.isExporting).toBe(false);
  });
});
```

#### Validation Criteria

- [ ] React hooks provide clean API for PDF export
- [ ] Unified export menu component created
- [ ] Migration adapters maintain backward compatibility
- [ ] Feature flags enable gradual rollout
- [ ] All existing export menus can be replaced
- [ ] Integration tests verify component behavior
- [ ] No breaking changes to existing UI

---

## Phase 4: Testing & Deployment (Weeks 9-12)

### 🚀 Production Readiness

**Objective**: Comprehensive testing, performance optimization, and production deployment

#### Deliverables

1. **Comprehensive Test Suite**
2. **Performance Optimization**
3. **Monitoring & Alerting**
4. **Production Deployment Plan**

#### Implementation

**4.1 Comprehensive Test Suite**

```javascript
// tests/pdf/integration/PDFExportIntegration.test.js
import { PDFExportService } from '../../../src/services/pdf';
import { ContentType } from '../../../src/services/pdf/types/interfaces';

describe('PDF Export Integration Tests', () => {
  let pdfService;
  
  beforeEach(() => {
    pdfService = new PDFExportService();
  });
  
  describe('End-to-End Export Tests', () => {
    test('exports complete chat conversation', async () => {
      const messages = [
        { role: 'user', content: 'Hello, how are you?', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'I am doing well, thank you for asking!', timestamp: new Date().toISOString() }
      ];
      
      const request = {
        content: messages,
        contentType: ContentType.CHAT_CONVERSATION,
        template: 'professional',
        options: {
          filename: 'test-chat.pdf',
          includeMetadata: true,
          includeTimestamps: true,
          metadata: {
            model: 'gpt-4',
            appName: 'Test App'
          }
        }
      };
      
      const blob = await pdfService.export(request);
      
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/pdf');
      expect(blob.size).toBeGreaterThan(1000); // Should be substantial
    });
    
    test('exports HTML with images', async () => {
      const htmlWithImage = `
        <h1>Document Title</h1>
        <p>This is a test document with an image:</p>
        <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iNTAiIGN5PSI1MCIgcj0iNDAiIGZpbGw9InJlZCIgLz4KPC9zdmc+" alt="Test SVG">
        <p>More content after the image.</p>
      `;
      
      const request = {
        content: htmlWithImage,
        contentType: ContentType.HTML,
        template: 'default',
        options: { filename: 'test-with-image.pdf' }
      };
      
      const blob = await pdfService.export(request);
      
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(2000); // Images should increase size
    });
    
    test('exports large SVG diagram', async () => {
      const largeSVG = `
        <svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
          <rect width="800" height="600" fill="#f0f0f0"/>
          ${Array.from({ length: 100 }, (_, i) => 
            `<circle cx="${50 + (i % 10) * 70}" cy="${50 + Math.floor(i / 10) * 50}" r="20" fill="#${(i * 123456).toString(16).slice(-6)}"/>`
          ).join('')}
        </svg>
      `;
      
      const request = {
        content: largeSVG,
        contentType: ContentType.SVG,
        template: 'minimal',
        options: { filename: 'large-diagram.pdf' }
      };
      
      const blob = await pdfService.export(request);
      
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(5000); // Complex SVG should be substantial
    });
  });
  
  describe('Performance Tests', () => {
    test('exports complete within time limits', async () => {
      const startTime = performance.now();
      
      const request = {
        content: '<h1>Simple Test</h1><p>Basic content for timing test.</p>',
        contentType: ContentType.HTML,
        template: 'default',
        options: { filename: 'timing-test.pdf' }
      };
      
      await pdfService.export(request);
      
      const duration = performance.now() - startTime;
      expect(duration).toBeLessThan(2000); // Should complete in under 2 seconds
    });
    
    test('handles concurrent exports', async () => {
      const requests = Array.from({ length: 5 }, (_, i) => ({
        content: `<h1>Concurrent Test ${i}</h1><p>Testing concurrent export capability.</p>`,
        contentType: ContentType.HTML,
        template: 'default',
        options: { filename: `concurrent-${i}.pdf` }
      }));
      
      const startTime = performance.now();
      const promises = requests.map(req => pdfService.export(req));
      const results = await Promise.all(promises);
      const duration = performance.now() - startTime;
      
      expect(results).toHaveLength(5);
      results.forEach(blob => {
        expect(blob).toBeInstanceOf(Blob);
        expect(blob.type).toBe('application/pdf');
      });
      
      // Should handle concurrent requests efficiently
      expect(duration).toBeLessThan(5000);
    });
  });
  
  describe('Error Handling Tests', () => {
    test('handles malformed content gracefully', async () => {
      const malformedHTML = '<div><p>Unclosed tags<div><span>More unclosed';
      
      const request = {
        content: malformedHTML,
        contentType: ContentType.HTML,
        template: 'default',
        options: { filename: 'malformed.pdf' }
      };
      
      // Should not throw, should handle gracefully
      const blob = await pdfService.export(request);
      expect(blob).toBeInstanceOf(Blob);
    });
    
    test('rejects oversized content', async () => {
      const oversizedContent = 'x'.repeat(10 * 1024 * 1024); // 10MB
      
      const request = {
        content: oversizedContent,
        contentType: ContentType.HTML,
        template: 'default',
        options: { filename: 'oversized.pdf' }
      };
      
      await expect(pdfService.export(request)).rejects.toThrow('Content size');
    });
  });
  
  describe('Security Tests', () => {
    test('sanitizes malicious content', async () => {
      const maliciousContent = `
        <script>alert('XSS');</script>
        <iframe src="javascript:alert('XSS')"></iframe>
        <img src="x" onerror="alert('XSS')">
        <p>Safe content</p>
      `;
      
      const request = {
        content: maliciousContent,
        contentType: ContentType.HTML,
        template: 'default',
        options: { filename: 'security-test.pdf' }
      };
      
      const blob = await pdfService.export(request);
      
      // Should complete without executing malicious code
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });
  });
});
```

**4.2 Performance Optimization**

```javascript
// client/src/services/pdf/utils/PerformanceOptimizer.js

/**
 * Performance optimization utilities for PDF export
 */
export class PerformanceOptimizer {
  constructor(config = {}) {
    this.config = {
      maxConcurrentExports: 3,
      memoryThreshold: 100 * 1024 * 1024, // 100MB
      gcInterval: 60000, // 1 minute
      ...config
    };
    
    this.activeExports = new Set();
    this.memoryMonitor = new MemoryMonitor();
    this.exportQueue = [];
    
    this._startMemoryMonitoring();
  }
  
  /**
   * Check if system can handle new export
   */
  canHandleExport() {
    return this.activeExports.size < this.config.maxConcurrentExports &&
           this.memoryMonitor.getUsage() < this.config.memoryThreshold;
  }
  
  /**
   * Queue export if system is at capacity
   */
  async queueExport(exportFn) {
    if (this.canHandleExport()) {
      return this._executeExport(exportFn);
    }
    
    return new Promise((resolve, reject) => {
      this.exportQueue.push({ exportFn, resolve, reject });
      this._processQueue();
    });
  }
  
  /**
   * Execute export with resource tracking
   */
  async _executeExport(exportFn) {
    const exportId = Math.random().toString(36).substr(2, 9);
    
    try {
      this.activeExports.add(exportId);
      const result = await exportFn();
      return result;
    } finally {
      this.activeExports.delete(exportId);
      this._processQueue();
    }
  }
  
  /**
   * Process queued exports
   */
  _processQueue() {
    if (this.exportQueue.length === 0 || !this.canHandleExport()) {
      return;
    }
    
    const { exportFn, resolve, reject } = this.exportQueue.shift();
    
    this._executeExport(exportFn)
      .then(resolve)
      .catch(reject);
  }
  
  /**
   * Start memory monitoring
   */
  _startMemoryMonitoring() {
    setInterval(() => {
      const usage = this.memoryMonitor.getUsage();
      
      if (usage > this.config.memoryThreshold) {
        console.warn('PDF Export: High memory usage detected:', usage);
        this._triggerGarbageCollection();
      }
    }, this.config.gcInterval);
  }
  
  /**
   * Trigger garbage collection if available
   */
  _triggerGarbageCollection() {
    if (window.gc && typeof window.gc === 'function') {
      window.gc();
    }
  }
}

/**
 * Memory monitoring utility
 */
class MemoryMonitor {
  getUsage() {
    if (performance.memory) {
      return performance.memory.usedJSHeapSize;
    }
    return 0;
  }
  
  getMemoryInfo() {
    if (performance.memory) {
      return {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize,
        limit: performance.memory.jsHeapSizeLimit
      };
    }
    return null;
  }
}
```

**4.3 Monitoring and Alerting**

```javascript
// client/src/services/pdf/monitoring/PDFExportMonitor.js

/**
 * Monitoring and metrics collection for PDF exports
 */
export class PDFExportMonitor {
  constructor(config = {}) {
    this.config = {
      enableMetrics: true,
      enableErrorTracking: true,
      sampleRate: 1.0, // 100% sampling by default
      ...config
    };
    
    this.metrics = {
      exports: {
        total: 0,
        successful: 0,
        failed: 0,
        byType: new Map(),
        byTemplate: new Map()
      },
      performance: {
        averageTime: 0,
        totalTime: 0,
        slowestExport: 0,
        fastestExport: Infinity
      },
      errors: []
    };
  }
  
  /**
   * Record export attempt
   */
  recordExportStart(request) {
    if (!this.config.enableMetrics || Math.random() > this.config.sampleRate) {
      return null;
    }
    
    const exportId = Math.random().toString(36).substr(2, 9);
    const startTime = performance.now();
    
    return {
      id: exportId,
      startTime,
      request: {
        contentType: request.contentType,
        template: request.template,
        contentSize: new Blob([request.content]).size
      }
    };
  }
  
  /**
   * Record successful export
   */
  recordExportSuccess(session, result) {
    if (!session) return;
    
    const duration = performance.now() - session.startTime;
    
    // Update metrics
    this.metrics.exports.total++;
    this.metrics.exports.successful++;
    
    // Update by type
    const typeCount = this.metrics.exports.byType.get(session.request.contentType) || 0;
    this.metrics.exports.byType.set(session.request.contentType, typeCount + 1);
    
    // Update by template
    const templateCount = this.metrics.exports.byTemplate.get(session.request.template) || 0;
    this.metrics.exports.byTemplate.set(session.request.template, templateCount + 1);
    
    // Update performance metrics
    this.metrics.performance.totalTime += duration;
    this.metrics.performance.averageTime = this.metrics.performance.totalTime / this.metrics.exports.total;
    this.metrics.performance.slowestExport = Math.max(this.metrics.performance.slowestExport, duration);
    this.metrics.performance.fastestExport = Math.min(this.metrics.performance.fastestExport, duration);
    
    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.log('[PDFExport] Success:', {
        type: session.request.contentType,
        template: session.request.template,
        duration: Math.round(duration),
        size: result.size
      });
    }
    
    // Send to analytics service if configured
    this._sendAnalytics('pdf_export_success', {
      content_type: session.request.contentType,
      template: session.request.template,
      duration,
      size: result.size,
      content_size: session.request.contentSize
    });
  }
  
  /**
   * Record export failure
   */
  recordExportFailure(session, error) {
    if (!session) return;
    
    const duration = performance.now() - session.startTime;
    
    // Update metrics
    this.metrics.exports.total++;
    this.metrics.exports.failed++;
    
    // Record error
    if (this.config.enableErrorTracking) {
      this.metrics.errors.push({
        timestamp: new Date().toISOString(),
        duration,
        error: error.message,
        stack: error.stack,
        request: session.request
      });
      
      // Keep only last 100 errors
      if (this.metrics.errors.length > 100) {
        this.metrics.errors = this.metrics.errors.slice(-100);
      }
    }
    
    // Log error
    console.error('[PDFExport] Failure:', {
      type: session.request.contentType,
      template: session.request.template,
      duration: Math.round(duration),
      error: error.message
    });
    
    // Send to error tracking service
    this._sendAnalytics('pdf_export_error', {
      content_type: session.request.contentType,
      template: session.request.template,
      duration,
      error: error.message,
      content_size: session.request.contentSize
    });
  }
  
  /**
   * Get current metrics
   */
  getMetrics() {
    const successRate = this.metrics.exports.total > 0 
      ? (this.metrics.exports.successful / this.metrics.exports.total) * 100 
      : 0;
    
    return {
      ...this.metrics,
      derived: {
        successRate,
        failureRate: 100 - successRate,
        averageTimeMs: Math.round(this.metrics.performance.averageTime),
        slowestTimeMs: Math.round(this.metrics.performance.slowestExport),
        fastestTimeMs: Math.round(this.metrics.performance.fastestExport)
      }
    };
  }
  
  /**
   * Send analytics data
   */
  _sendAnalytics(event, data) {
    // Placeholder for analytics integration
    // Could integrate with Google Analytics, Mixpanel, etc.
    if (window.gtag) {
      window.gtag('event', event, data);
    }
  }
  
  /**
   * Generate metrics report
   */
  generateReport() {
    const metrics = this.getMetrics();
    
    return {
      summary: {
        totalExports: metrics.exports.total,
        successRate: `${metrics.derived.successRate.toFixed(1)}%`,
        averageTime: `${metrics.derived.averageTimeMs}ms`,
        slowestExport: `${metrics.derived.slowestTimeMs}ms`
      },
      byContentType: Object.fromEntries(metrics.exports.byType),
      byTemplate: Object.fromEntries(metrics.exports.byTemplate),
      recentErrors: metrics.errors.slice(-10),
      performance: {
        averageTimeMs: metrics.derived.averageTimeMs,
        slowestTimeMs: metrics.derived.slowestTimeMs,
        fastestTimeMs: metrics.derived.fastestTimeMs
      }
    };
  }
}
```

**4.4 Production Deployment Configuration**

```javascript
// config/production/pdf-export.config.js

/**
 * Production configuration for PDF export system
 */
export const productionPDFConfig = {
  // Security settings - restrictive for production
  security: {
    sanitizeContent: true,
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'div', 'span',
      'strong', 'em', 'b', 'i', 'u',
      'ul', 'ol', 'li',
      'blockquote', 'code', 'pre',
      'table', 'thead', 'tbody', 'tr', 'td', 'th'
    ],
    allowedAttributes: [
      'class', 'id', 'style',
      'colspan', 'rowspan'
    ],
    maxContentSize: 2 * 1024 * 1024, // 2MB in production
    timeout: 15000 // 15 seconds max
  },
  
  // Resource management - conservative for production
  resources: {
    maxConcurrentExports: 2, // Lower for production
    memoryLimit: 50 * 1024 * 1024, // 50MB
    cleanupInterval: 30000, // 30 seconds
    retentionTime: 180000 // 3 minutes
  },
  
  // Quality settings
  quality: {
    defaultDPI: 150,
    maxDPI: 200, // Lower max DPI for performance
    compression: 'HIGH', // Higher compression for smaller files
    imageSmoothingEnabled: true,
    scaleFactor: 1.5 // Lower scale factor for performance
  },
  
  // Error handling - user-friendly for production
  errors: {
    logErrors: true,
    includeStack: false, // Don't expose stack traces
    userFriendlyMessages: true
  },
  
  // Monitoring - enabled for production
  monitoring: {
    enableMetrics: true,
    enableErrorTracking: true,
    sampleRate: 0.1 // 10% sampling to reduce overhead
  },
  
  // Feature flags
  features: {
    enableSVGExport: true,
    enableCanvasExport: true,
    enableChatExport: true,
    enableBatchExport: false, // Disabled initially
    enableBackgroundProcessing: false // Disabled initially
  }
};
```

#### Deployment Checklist

**4.5 Production Deployment Steps**

```bash
#!/bin/bash
# deploy-pdf-export.sh

set -e

echo "🚀 Deploying Centralized PDF Export System"

# 1. Pre-deployment checks
echo "📋 Running pre-deployment checks..."
npm run test:pdf-export
npm run lint:pdf-export
npm run security:scan

# 2. Build with production config
echo "🏗️ Building with production configuration..."
export NODE_ENV=production
export PDF_EXPORT_CONFIG=production
npm run build

# 3. Database migrations (if any)
echo "🗄️ Running database migrations..."
# npm run migrate (if needed)

# 4. Feature flag setup
echo "🎛️ Setting up feature flags..."
curl -X POST "$ADMIN_API_URL/api/admin/feature-flags" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "centralizedPDFExport": {
      "enabled": false,
      "rolloutPercentage": 0
    }
  }'

# 5. Deploy to staging
echo "🧪 Deploying to staging..."
npm run deploy:staging

# 6. Run integration tests
echo "🧪 Running integration tests on staging..."
npm run test:integration:staging

# 7. Gradual production rollout
echo "📈 Starting gradual rollout..."

for percentage in 5 10 25 50 100; do
  echo "Rolling out to ${percentage}% of users..."
  
  curl -X PATCH "$ADMIN_API_URL/api/admin/feature-flags/centralizedPDFExport" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"rolloutPercentage\": $percentage}"
  
  echo "Waiting 30 minutes for monitoring..."
  sleep 1800
  
  # Check error rate
  error_rate=$(curl -s "$MONITORING_API_URL/pdf-export/error-rate" | jq -r '.errorRate')
  if (( $(echo "$error_rate > 5.0" | bc -l) )); then
    echo "❌ Error rate too high: $error_rate%. Rolling back..."
    curl -X PATCH "$ADMIN_API_URL/api/admin/feature-flags/centralizedPDFExport" \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"rolloutPercentage": 0}'
    exit 1
  fi
  
  echo "✅ Rollout to ${percentage}% successful"
done

echo "🎉 Deployment completed successfully!"

# 8. Enable monitoring alerts
echo "📊 Enabling monitoring alerts..."
curl -X POST "$MONITORING_API_URL/alerts" \
  -H "Authorization: Bearer $MONITORING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PDF Export Error Rate",
    "condition": "error_rate > 2%",
    "duration": "5m",
    "severity": "high"
  }'

echo "✅ Centralized PDF Export System deployed successfully!"
```

#### Validation Criteria

- [ ] All integration tests pass with 95%+ success rate
- [ ] Performance benchmarks meet targets (<2s simple, <10s complex)
- [ ] Security tests validate input sanitization
- [ ] Memory usage stays within configured limits
- [ ] Error rates remain below 2% in production
- [ ] Monitoring and alerting systems operational
- [ ] Gradual rollout process documented and tested
- [ ] Rollback procedures validated

---

## Migration Checklist

### File Replacement Strategy

#### Phase 1: Security Patches (Immediate)
- [ ] Update `client/src/features/canvas/components/ExportMenu.jsx`
- [ ] Update `client/src/api/endpoints/apps.js`
- [ ] Add DOMPurify dependency
- [ ] Test security fixes

#### Phase 2: Core Infrastructure
- [ ] Create `client/src/services/pdf/` directory structure
- [ ] Implement `PDFExportService.js`
- [ ] Implement security framework
- [ ] Implement configuration system
- [ ] Add comprehensive tests

#### Phase 3: Content Processors
- [ ] Implement `HTMLProcessor.js`
- [ ] Implement `SVGProcessor.js`
- [ ] Implement `ChatProcessor.js`
- [ ] Implement `CanvasProcessor.js`
- [ ] Test all processors individually

#### Phase 4: React Integration
- [ ] Create `usePDFExport.js` hook
- [ ] Create `PDFExportMenu.jsx` component
- [ ] Create migration adapters
- [ ] Update existing components with feature flags
- [ ] Test React integration

#### Phase 5: Migration
- [ ] Replace `ExportConversationMenu.jsx`
- [ ] Replace canvas export functionality
- [ ] Replace Mermaid PDF export
- [ ] Remove old implementations
- [ ] Update documentation

### Performance Targets

| Content Type | Target Time | Max Memory | Success Rate |
|--------------|-------------|------------|--------------|
| Simple HTML  | <2s         | 10MB       | >99%         |
| Chat (50 msgs) | <3s       | 15MB       | >99%         |
| Large SVG    | <5s         | 20MB       | >95%         |
| Complex Canvas | <10s      | 25MB       | >95%         |

### Success Metrics

- **Security**: 0 XSS vulnerabilities in production
- **Performance**: 99%+ exports complete within target times
- **Reliability**: <2% error rate across all content types
- **Code Quality**: 95% reduction in duplicate PDF code
- **Maintainability**: Single service handles all export types
- **User Experience**: Consistent export interface across features

This comprehensive implementation plan provides a practical, step-by-step approach to implementing the centralized PDF export system. Each phase builds upon the previous one, ensuring security vulnerabilities are addressed immediately while delivering a robust, extensible solution that will serve as the foundation for all PDF export needs in AI Hub Apps.

The plan balances immediate security fixes with long-term architectural improvements, providing clear validation criteria and testing strategies for each phase. The gradual migration approach with feature flags ensures production stability while enabling the development team to deliver improvements incrementally.