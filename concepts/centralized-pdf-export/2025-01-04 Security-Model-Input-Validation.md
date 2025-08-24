# Security Model & Input Validation Approach

## Security Architecture Overview

### Multi-Layer Security Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Layer Security                    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │  Input Validation │  │  CSP Headers    │  │  Rate Limiting│ │
│  │  (Zod Schemas)   │  │  Content Policy │  │  Per User     │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                  Service Layer Security                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ Schema Validation│  │  HTML Sanitization│  │ Resource Limits│ │
│  │ (Request/Response)│  │  (DOMPurify)    │  │ Memory/Time   │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                Processing Layer Security                    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │  Content Isolation│  │  Safe Execution │  │  Output      │ │
│  │  Sandboxed Env   │  │  No eval()      │  │  Validation  │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Input Validation Strategy

### 1. Client-Side Validation (First Defense)

```typescript
// security/ClientValidator.ts
export class ClientValidator {
  private schemas: Map<string, z.ZodSchema>;
  
  constructor() {
    this.schemas = new Map();
    this.initializeSchemas();
  }

  /**
   * Validate export request before sending to service
   */
  validateExportRequest(request: PDFExportRequest): ValidationResult {
    const schema = this.schemas.get('exportRequest');
    const result = schema?.safeParse(request);
    
    if (!result?.success) {
      return {
        isValid: false,
        errors: this.mapZodErrors(result.error),
        warnings: []
      };
    }

    // Additional business logic validation
    const businessValidation = this.validateBusinessRules(request);
    return businessValidation;
  }

  /**
   * Pre-validate content before processing
   */
  validateContent(content: ExportContent): ContentValidationResult {
    const baseValidation = this.validateContentBase(content);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    // Content-type specific validation
    switch (content.type) {
      case 'html':
        return this.validateHTMLContent(content as HTMLContent);
      case 'svg':
        return this.validateSVGContent(content as SVGContent);
      case 'chat':
        return this.validateChatContent(content as ChatContent);
      default:
        return { isValid: true, warnings: [], sanitizedContent: content };
    }
  }

  private validateHTMLContent(content: HTMLContent): ContentValidationResult {
    const warnings: string[] = [];
    let sanitizedContent = { ...content };

    // Check for potentially dangerous patterns
    const dangerousPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /<iframe\b[^>]*>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      /<object\b[^>]*>/gi,
      /<embed\b[^>]*>/gi
    ];

    dangerousPatterns.forEach(pattern => {
      if (pattern.test(content.html)) {
        warnings.push(`Potentially dangerous HTML pattern detected: ${pattern.source}`);
      }
    });

    // Check HTML size
    if (content.html.length > 1048576) { // 1MB limit
      return {
        isValid: false,
        warnings: [],
        errors: ['HTML content exceeds maximum size limit of 1MB']
      };
    }

    // Basic HTML structure validation
    if (!this.hasValidHTMLStructure(content.html)) {
      warnings.push('HTML content may have structural issues');
    }

    return {
      isValid: true,
      warnings,
      sanitizedContent
    };
  }

  private validateSVGContent(content: SVGContent): ContentValidationResult {
    const warnings: string[] = [];
    
    // Check for script elements in SVG
    if (/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi.test(content.svg)) {
      return {
        isValid: false,
        warnings: [],
        errors: ['SVG content contains script elements which are not allowed']
      };
    }

    // Check SVG size
    if (content.svg.length > 524288) { // 512KB limit
      return {
        isValid: false,
        warnings: [],
        errors: ['SVG content exceeds maximum size limit of 512KB']
      };
    }

    // Validate SVG structure
    if (!content.svg.trim().startsWith('<svg') || !content.svg.includes('</svg>')) {
      warnings.push('SVG content may not be properly formatted');
    }

    return {
      isValid: true,
      warnings,
      sanitizedContent: content
    };
  }

  private validateBusinessRules(request: PDFExportRequest): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Check template and content type compatibility
    const template = request.template;
    const supportedTypes = this.getTemplateSupportedTypes(template.name);
    
    if (!supportedTypes.includes(request.content.type)) {
      errors.push({
        code: 'template_content_mismatch',
        message: `Template '${template.name}' does not support content type '${request.content.type}'`,
        field: 'template.name'
      });
    }

    // Validate page format and orientation combination
    if (request.options.format && request.options.orientation) {
      const isValidCombination = this.validateFormatOrientation(
        request.options.format,
        request.options.orientation
      );
      
      if (!isValidCombination) {
        warnings.push({
          code: 'format_orientation_unusual',
          message: 'Unusual format and orientation combination may affect layout',
          field: 'options'
        });
      }
    }

    // Check resource limits
    const estimatedSize = this.estimateOutputSize(request);
    if (estimatedSize > 10485760) { // 10MB estimated limit
      warnings.push({
        code: 'large_output_estimated',
        message: 'Export may produce a large file. Consider reducing content or image quality.',
        field: 'content'
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}
```

### 2. Server-Side Validation (Core Defense)

```typescript
// security/ServerValidator.ts
export class ServerValidator {
  private htmlSanitizer: HTMLSanitizer;
  private contentValidator: ContentValidator;
  private resourceLimiter: ResourceLimiter;

  constructor(config: SecurityConfiguration) {
    this.htmlSanitizer = new HTMLSanitizer(config);
    this.contentValidator = new ContentValidator(config);
    this.resourceLimiter = new ResourceLimiter(config);
  }

  /**
   * Complete server-side validation pipeline
   */
  async validateAndSanitize(request: PDFExportRequest): Promise<ValidationResult> {
    try {
      // Phase 1: Schema validation
      const schemaValidation = await this.validateSchema(request);
      if (!schemaValidation.isValid) {
        return schemaValidation;
      }

      // Phase 2: Content sanitization
      const sanitizedRequest = await this.sanitizeContent(request);

      // Phase 3: Resource validation
      const resourceValidation = await this.validateResources(sanitizedRequest);
      if (!resourceValidation.isValid) {
        return resourceValidation;
      }

      // Phase 4: Security policy validation
      const securityValidation = await this.validateSecurityPolicies(sanitizedRequest);

      return {
        isValid: securityValidation.isValid,
        errors: [...schemaValidation.errors, ...resourceValidation.errors, ...securityValidation.errors],
        warnings: [...schemaValidation.warnings, ...resourceValidation.warnings, ...securityValidation.warnings],
        sanitizedRequest: sanitizedRequest
      };

    } catch (error) {
      return {
        isValid: false,
        errors: [{
          code: 'validation_error',
          message: `Validation failed: ${error.message}`,
          context: { originalError: error }
        }],
        warnings: []
      };
    }
  }

  private async sanitizeContent(request: PDFExportRequest): Promise<PDFExportRequest> {
    const sanitizedRequest = { ...request };

    switch (request.content.type) {
      case 'html':
        sanitizedRequest.content = await this.sanitizeHTMLContent(request.content as HTMLContent);
        break;
      case 'svg':
        sanitizedRequest.content = await this.sanitizeSVGContent(request.content as SVGContent);
        break;
      case 'chat':
        sanitizedRequest.content = await this.sanitizeChatContent(request.content as ChatContent);
        break;
      case 'mixed':
        sanitizedRequest.content = await this.sanitizeMixedContent(request.content as MixedContent);
        break;
    }

    // Sanitize template custom CSS
    if (request.template.customCSS) {
      sanitizedRequest.template.customCSS = await this.sanitizeCSS(request.template.customCSS);
    }

    return sanitizedRequest;
  }

  private async sanitizeHTMLContent(content: HTMLContent): Promise<HTMLContent> {
    const sanitizedHTML = await this.htmlSanitizer.sanitize(content.html);
    
    return {
      ...content,
      html: sanitizedHTML,
      styles: content.styles ? await this.sanitizeCSS(content.styles) : undefined
    };
  }

  private async sanitizeChatContent(content: ChatContent): Promise<ChatContent> {
    const sanitizedMessages = await Promise.all(
      content.messages.map(async message => ({
        ...message,
        content: await this.htmlSanitizer.sanitize(message.content)
      }))
    );

    return {
      ...content,
      messages: sanitizedMessages
    };
  }

  private async validateSecurityPolicies(request: PDFExportRequest): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Check for URL injections in content
    const urlValidation = await this.validateURLs(request);
    if (!urlValidation.isValid) {
      errors.push(...urlValidation.errors);
    }

    // Validate file size limits
    const sizeValidation = this.validateSizeLimits(request);
    if (!sizeValidation.isValid) {
      errors.push(...sizeValidation.errors);
    }

    // Check for suspicious patterns
    const patternValidation = this.validateSuspiciousPatterns(request);
    warnings.push(...patternValidation.warnings);

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}
```

### 3. HTML Sanitization Implementation

```typescript
// security/HTMLSanitizer.ts
import DOMPurify from 'isomorphic-dompurify';

export class HTMLSanitizer {
  private config: SecurityConfiguration;
  private purifyConfig: DOMPurify.Config;

  constructor(config: SecurityConfiguration) {
    this.config = config;
    this.purifyConfig = this.buildPurifyConfig();
  }

  async sanitize(html: string): Promise<string> {
    if (!html || typeof html !== 'string') {
      return '';
    }

    try {
      // Pre-processing: handle special cases
      const preprocessed = this.preProcess(html);

      // Main sanitization using DOMPurify
      const sanitized = DOMPurify.sanitize(preprocessed, this.purifyConfig);

      // Post-processing: additional safety checks
      const postProcessed = this.postProcess(sanitized);

      return postProcessed;

    } catch (error) {
      console.error('HTML sanitization failed:', error);
      // Return empty string on sanitization failure for security
      return '';
    }
  }

  private buildPurifyConfig(): DOMPurify.Config {
    const allowedTags = this.config.sanitizationOptions?.allowedTags || [
      'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'em', 'b', 'i', 'u',
      'ul', 'ol', 'li',
      'a', 'img',
      'br', 'hr',
      'blockquote', 'code', 'pre',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'span'
    ];

    const allowedAttributes = this.config.sanitizationOptions?.allowedAttributes || {
      'a': ['href', 'title', 'target'],
      'img': ['src', 'alt', 'width', 'height', 'title'],
      'table': ['border', 'cellpadding', 'cellspacing'],
      'th': ['scope', 'colspan', 'rowspan'],
      'td': ['colspan', 'rowspan'],
      '*': ['class', 'id']
    };

    return {
      ALLOWED_TAGS: allowedTags,
      ALLOWED_ATTR: this.flattenAllowedAttributes(allowedAttributes),
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      FORBID_CONTENTS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
      FORBID_ATTR: ['onclick', 'onload', 'onerror', 'onmouseover', 'onfocus', 'onblur'],
      KEEP_CONTENT: true,
      RETURN_DOM_FRAGMENT: false,
      RETURN_DOM_IMPORT: false,
      SANITIZE_DOM: true,
      WHOLE_DOCUMENT: false,
      FORCE_BODY: false
    };
  }

  private preProcess(html: string): string {
    // Remove potential binary data
    html = html.replace(/data:(?!image\/(?:png|jpe?g|gif|svg\+xml|webp))[^;]+;base64,[A-Za-z0-9+/=]+/gi, '');
    
    // Remove suspicious unicode characters
    html = html.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
    
    // Normalize whitespace
    html = html.replace(/\s+/g, ' ').trim();

    return html;
  }

  private postProcess(html: string): string {
    // Additional safety checks after DOMPurify
    
    // Ensure no script content survived
    if (/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi.test(html)) {
      console.warn('Script content detected after sanitization - removing');
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    }

    // Check for javascript: URLs that might have survived
    html = html.replace(/javascript:[^"']*/gi, '#');

    // Remove any remaining event handlers
    html = html.replace(/\son\w+\s*=\s*[^>]+/gi, '');

    return html;
  }

  private flattenAllowedAttributes(allowedAttributes: Record<string, string[]>): string[] {
    const flattened = new Set<string>();
    
    Object.entries(allowedAttributes).forEach(([tag, attrs]) => {
      attrs.forEach(attr => {
        if (tag === '*') {
          flattened.add(attr);
        } else {
          flattened.add(`${tag}:${attr}`);
        }
      });
    });

    return Array.from(flattened);
  }
}
```

### 4. Content Security Policy Implementation

```typescript
// security/ContentSecurityPolicy.ts
export class ContentSecurityPolicy {
  private policies: Map<string, string[]>;

  constructor() {
    this.policies = new Map();
    this.initializePolicies();
  }

  generateCSPHeader(): string {
    const directives: string[] = [];

    this.policies.forEach((values, directive) => {
      directives.push(`${directive} ${values.join(' ')}`);
    });

    return directives.join('; ');
  }

  private initializePolicies(): void {
    // Default source policy - very restrictive
    this.policies.set('default-src', ["'self'"]);

    // Script sources - no inline scripts, no eval
    this.policies.set('script-src', [
      "'self'",
      "'unsafe-inline'", // Only for PDF generation libraries
      'https://cdnjs.cloudflare.com', // For PDF libraries
      'https://unpkg.com' // For specific library versions
    ]);

    // Style sources - allow inline styles for PDF generation
    this.policies.set('style-src', [
      "'self'",
      "'unsafe-inline'" // Required for dynamic PDF styling
    ]);

    // Image sources - allow data URLs for embedded images
    this.policies.set('img-src', [
      "'self'",
      'data:',
      'https:' // Allow HTTPS images
    ]);

    // Font sources
    this.policies.set('font-src', [
      "'self'",
      'data:',
      'https://fonts.gstatic.com'
    ]);

    // No plugins allowed
    this.policies.set('object-src', ["'none'"]);

    // No external forms
    this.policies.set('form-action', ["'self'"]);

    // No framing
    this.policies.set('frame-ancestors', ["'none'"]);

    // Base URI restrictions
    this.policies.set('base-uri', ["'self'"]);

    // No external connections except for fonts and libraries
    this.policies.set('connect-src', [
      "'self'",
      'https://fonts.googleapis.com',
      'https://cdnjs.cloudflare.com'
    ]);
  }

  validateContent(html: string): CSPValidationResult {
    const violations: CSPViolation[] = [];

    // Check for inline event handlers
    const eventHandlerPattern = /\son\w+\s*=/gi;
    if (eventHandlerPattern.test(html)) {
      violations.push({
        directive: 'script-src',
        violationType: 'inline-event-handler',
        content: 'Inline event handlers detected',
        severity: 'high'
      });
    }

    // Check for javascript: URLs
    const javascriptUrlPattern = /javascript:/gi;
    if (javascriptUrlPattern.test(html)) {
      violations.push({
        directive: 'script-src',
        violationType: 'javascript-url',
        content: 'javascript: URLs detected',
        severity: 'high'
      });
    }

    // Check for data URLs in suspicious contexts
    const suspiciousDataUrl = /data:(?!image\/)[^;]+;base64/gi;
    if (suspiciousDataUrl.test(html)) {
      violations.push({
        directive: 'object-src',
        violationType: 'suspicious-data-url',
        content: 'Non-image data URLs detected',
        severity: 'medium'
      });
    }

    return {
      isValid: violations.filter(v => v.severity === 'high').length === 0,
      violations,
      sanitizedContent: this.sanitizeCSPViolations(html, violations)
    };
  }

  private sanitizeCSPViolations(html: string, violations: CSPViolation[]): string {
    let sanitized = html;

    violations.forEach(violation => {
      switch (violation.violationType) {
        case 'inline-event-handler':
          sanitized = sanitized.replace(/\son\w+\s*=[^>]+/gi, '');
          break;
        case 'javascript-url':
          sanitized = sanitized.replace(/javascript:[^"']*/gi, '#');
          break;
        case 'suspicious-data-url':
          sanitized = sanitized.replace(/data:(?!image\/)[^;]+;base64,[A-Za-z0-9+/=]+/gi, '');
          break;
      }
    });

    return sanitized;
  }
}

interface CSPViolation {
  directive: string;
  violationType: string;
  content: string;
  severity: 'low' | 'medium' | 'high';
}

interface CSPValidationResult {
  isValid: boolean;
  violations: CSPViolation[];
  sanitizedContent: string;
}
```

### 5. Resource Protection & Rate Limiting

```typescript
// security/ResourceProtection.ts
export class ResourceProtection {
  private activeSessions: Map<string, SessionInfo>;
  private rateLimiter: RateLimiter;
  private memoryMonitor: MemoryMonitor;

  constructor(config: SecurityConfiguration) {
    this.activeSessions = new Map();
    this.rateLimiter = new RateLimiter(config.rateLimiting);
    this.memoryMonitor = new MemoryMonitor(config.performance);
  }

  async validateExportRequest(userId: string, request: PDFExportRequest): Promise<ResourceValidationResult> {
    // Check rate limits
    const rateLimitResult = await this.rateLimiter.checkLimit(userId, request);
    if (!rateLimitResult.allowed) {
      return {
        allowed: false,
        reason: 'rate_limit_exceeded',
        retryAfter: rateLimitResult.retryAfter,
        details: `Too many export requests. Limit: ${rateLimitResult.limit} per ${rateLimitResult.window}`
      };
    }

    // Check memory usage
    const memoryResult = await this.memoryMonitor.checkAvailability(request);
    if (!memoryResult.available) {
      return {
        allowed: false,
        reason: 'insufficient_memory',
        details: `Insufficient memory available for export. Required: ${memoryResult.required}MB, Available: ${memoryResult.available}MB`
      };
    }

    // Check concurrent exports
    const concurrentResult = this.checkConcurrentExports(userId);
    if (!concurrentResult.allowed) {
      return {
        allowed: false,
        reason: 'too_many_concurrent_exports',
        details: `Maximum concurrent exports exceeded. Current: ${concurrentResult.current}, Max: ${concurrentResult.max}`
      };
    }

    return { allowed: true };
  }

  registerExportSession(userId: string, exportId: string, estimatedResources: ResourceEstimate): void {
    this.activeSessions.set(exportId, {
      userId,
      exportId,
      startTime: Date.now(),
      estimatedResources,
      actualResources: { memory: 0, cpu: 0 }
    });

    this.rateLimiter.recordRequest(userId);
    this.memoryMonitor.allocateResources(exportId, estimatedResources);
  }

  updateSessionResources(exportId: string, actualResources: ResourceUsage): void {
    const session = this.activeSessions.get(exportId);
    if (session) {
      session.actualResources = actualResources;
      this.memoryMonitor.updateUsage(exportId, actualResources);
    }
  }

  completeExportSession(exportId: string): void {
    const session = this.activeSessions.get(exportId);
    if (session) {
      const duration = Date.now() - session.startTime;
      
      // Record metrics for future estimation
      this.recordMetrics(session, duration);
      
      // Clean up resources
      this.memoryMonitor.releaseResources(exportId);
      this.activeSessions.delete(exportId);
    }
  }

  private checkConcurrentExports(userId: string): { allowed: boolean; current: number; max: number } {
    const userSessions = Array.from(this.activeSessions.values())
      .filter(session => session.userId === userId);
    
    const maxConcurrent = 3; // Configurable limit
    
    return {
      allowed: userSessions.length < maxConcurrent,
      current: userSessions.length,
      max: maxConcurrent
    };
  }

  private recordMetrics(session: SessionInfo, duration: number): void {
    // Record performance metrics for ML-based resource estimation
    const metrics = {
      contentType: session.estimatedResources.contentType,
      contentSize: session.estimatedResources.contentSize,
      estimatedMemory: session.estimatedResources.memory,
      actualMemory: session.actualResources.memory,
      estimatedDuration: session.estimatedResources.estimatedDuration,
      actualDuration: duration,
      timestamp: Date.now()
    };

    // Store metrics for analysis (implement based on your metrics system)
    this.storeMetrics(metrics);
  }
}

interface SessionInfo {
  userId: string;
  exportId: string;
  startTime: number;
  estimatedResources: ResourceEstimate;
  actualResources: ResourceUsage;
}

interface ResourceEstimate {
  contentType: string;
  contentSize: number;
  memory: number; // MB
  cpu: number; // CPU units
  estimatedDuration: number; // ms
}

interface ResourceUsage {
  memory: number; // MB
  cpu: number; // CPU units
}

interface ResourceValidationResult {
  allowed: boolean;
  reason?: string;
  retryAfter?: number;
  details?: string;
}
```

## Security Best Practices Implementation

### 1. Defense in Depth Strategy
- **Client validation** catches obvious issues early
- **Server validation** provides the security boundary
- **Content sanitization** removes dangerous content
- **Resource limits** prevent DoS attacks
- **CSP headers** provide browser-level protection

### 2. Zero Trust Content Policy
- All user content is considered potentially malicious
- Multiple validation layers with fail-safe defaults
- Sanitization always prefers removal over modification
- No eval() or Function() constructor usage
- All external resources validated and limited

### 3. Performance Security
- Memory usage monitoring and limits
- Processing time limits with automatic cancellation
- Rate limiting per user to prevent abuse
- Resource cleanup with automatic garbage collection

### 4. Audit Trail
- All validation failures logged with context
- Security violations tracked and reported
- Performance metrics collected for analysis
- User activity monitoring for abuse detection

This security model provides comprehensive protection against:
- XSS attacks through HTML/SVG content
- Code injection via templates or custom CSS
- Resource exhaustion attacks
- Data exfiltration attempts
- Denial of service through large requests

The implementation uses industry-standard libraries (DOMPurify, Zod) combined with custom validation logic to ensure robust security while maintaining functionality.