# Configuration Schema & Template System

## Configuration Schema Definition

### JSON Schema for Export Configuration

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PDF Export Configuration",
  "type": "object",
  "properties": {
    "service": {
      "type": "object",
      "properties": {
        "defaultGenerator": {
          "type": "string",
          "enum": ["jspdf", "html-print", "canvas"],
          "default": "jspdf"
        },
        "maxConcurrentExports": {
          "type": "number",
          "minimum": 1,
          "maximum": 10,
          "default": 3
        },
        "exportTimeout": {
          "type": "number",
          "minimum": 5000,
          "maximum": 300000,
          "default": 60000
        }
      }
    },
    "security": {
      "type": "object",
      "properties": {
        "sanitizeHTML": {
          "type": "boolean",
          "default": true
        },
        "allowedTags": {
          "type": "array",
          "items": { "type": "string" },
          "default": ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "ul", "ol", "li", "a", "img", "br"]
        },
        "allowedAttributes": {
          "type": "object",
          "additionalProperties": {
            "type": "array",
            "items": { "type": "string" }
          },
          "default": {
            "a": ["href", "title"],
            "img": ["src", "alt", "width", "height"],
            "*": ["class", "id"]
          }
        },
        "maxContentSize": {
          "type": "number",
          "minimum": 1024,
          "maximum": 10485760,
          "default": 1048576
        },
        "maxImageDimensions": {
          "type": "object",
          "properties": {
            "width": { "type": "number", "maximum": 4096, "default": 2048 },
            "height": { "type": "number", "maximum": 4096, "default": 2048 }
          }
        }
      }
    },
    "performance": {
      "type": "object",
      "properties": {
        "maxMemoryUsage": {
          "type": "number",
          "minimum": 16777216,
          "maximum": 268435456,
          "default": 67108864
        },
        "resourceCleanupDelay": {
          "type": "number",
          "minimum": 100,
          "maximum": 5000,
          "default": 1000
        },
        "enableProgressTracking": {
          "type": "boolean",
          "default": true
        }
      }
    },
    "templates": {
      "type": "object",
      "properties": {
        "defaultTemplate": {
          "type": "string",
          "default": "default"
        },
        "customTemplatesPath": {
          "type": "string",
          "default": "./templates/custom"
        },
        "enableCustomCSS": {
          "type": "boolean",
          "default": true
        }
      }
    }
  }
}
```

### Zod Validation Schemas

```typescript
// config/validationSchemas.ts
import { z } from 'zod';

// Core export request schema
export const PDFExportRequestSchema = z.object({
  exportId: z.string().optional(),
  content: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('html'),
      html: z.string().min(1).max(1048576),
      styles: z.string().optional(),
      baseUrl: z.string().url().optional()
    }),
    z.object({
      type: z.literal('svg'),
      svg: z.string().min(1).max(524288),
      dimensions: z.object({
        width: z.number().positive().max(4096),
        height: z.number().positive().max(4096)
      }).optional(),
      backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()
    }),
    z.object({
      type: z.literal('canvas'),
      canvas: z.union([z.string(), z.instanceof(HTMLCanvasElement)]),
      format: z.enum(['png', 'jpeg']).optional(),
      quality: z.number().min(0).max(1).optional()
    }),
    z.object({
      type: z.literal('chat'),
      messages: z.array(z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string().min(1),
        timestamp: z.union([z.number(), z.string()]).optional(),
        metadata: z.record(z.any()).optional()
      })).min(1),
      chatInfo: z.object({
        appName: z.string().optional(),
        model: z.string().optional(),
        settings: z.record(z.any()).optional()
      }).optional()
    }),
    z.object({
      type: z.literal('mixed'),
      sections: z.array(z.object({
        id: z.string(),
        title: z.string().optional(),
        content: z.any(), // Recursive reference to content types
        options: z.any().optional()
      })).min(1),
      toc: z.object({
        enabled: z.boolean(),
        title: z.string().optional(),
        maxLevel: z.number().min(1).max(6),
        includePageNumbers: z.boolean(),
        position: z.enum(['beginning', 'end'])
      }).optional()
    })
  ]),
  options: z.object({
    format: z.union([
      z.enum(['A4', 'A3', 'Letter', 'Legal', 'Tabloid']),
      z.tuple([z.number().positive(), z.number().positive()])
    ]).optional(),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    margins: z.object({
      top: z.number().min(0).max(50),
      right: z.number().min(0).max(50),
      bottom: z.number().min(0).max(50),
      left: z.number().min(0).max(50)
    }).optional(),
    quality: z.object({
      imageCompression: z.number().min(0).max(1),
      compress: z.boolean(),
      dpi: z.number().min(72).max(300)
    }).optional(),
    headerFooter: z.object({
      header: z.object({
        template: z.string(),
        height: z.number().min(0).max(50).optional(),
        showOnFirstPage: z.boolean().optional(),
        styles: z.string().optional()
      }).optional(),
      footer: z.object({
        template: z.string(),
        height: z.number().min(0).max(50).optional(),
        showOnFirstPage: z.boolean().optional(),
        styles: z.string().optional()
      }).optional()
    }).optional(),
    watermark: z.object({
      text: z.string().min(1).max(100),
      position: z.enum(['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'bottom-center']),
      opacity: z.number().min(0.1).max(1),
      rotation: z.number().min(-180).max(180).optional(),
      font: z.object({
        size: z.number().min(8).max(72),
        family: z.string().optional(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()
      }).optional()
    }).optional(),
    security: z.object({
      restrictPrinting: z.boolean().optional(),
      restrictCopying: z.boolean().optional(),
      restrictEditing: z.boolean().optional(),
      userPassword: z.string().min(1).max(32).optional(),
      ownerPassword: z.string().min(1).max(32).optional()
    }).optional()
  }),
  template: z.object({
    name: z.string().min(1),
    variant: z.enum(['default', 'professional', 'minimal', 'corporate']).optional(),
    customCSS: z.string().max(102400).optional(),
    typography: z.object({
      fontFamily: z.string().optional(),
      fontSize: z.number().min(8).max(24).optional(),
      lineHeight: z.number().min(1).max(3).optional(),
      headingScale: z.number().min(1).max(2).optional()
    }).optional(),
    colors: z.object({
      primary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      secondary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      text: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      background: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()
    }).optional(),
    layout: z.object({
      contentWidth: z.number().min(200).max(800).optional(),
      spacing: z.enum(['tight', 'normal', 'loose']).optional(),
      alignment: z.enum(['left', 'center', 'justify']).optional()
    }).optional()
  }),
  security: z.object({
    sanitizeHTML: z.boolean(),
    sanitizationOptions: z.object({
      allowedTags: z.array(z.string()).optional(),
      allowedAttributes: z.record(z.array(z.string())).optional(),
      allowedSchemes: z.array(z.string()).optional()
    }).optional(),
    limits: z.object({
      maxHTMLSize: z.number().positive(),
      maxSVGSize: z.number().positive(),
      maxImageDimensions: z.object({
        width: z.number().positive(),
        height: z.number().positive()
      }),
      maxPages: z.number().min(1).max(500)
    }).optional(),
    resourceValidation: z.object({
      validateUrls: z.boolean(),
      allowedSchemes: z.array(z.string())
    }).optional()
  }).optional(),
  metadata: z.object({
    timestamp: z.number(),
    userId: z.string().optional(),
    appContext: z.object({
      appId: z.string().optional(),
      chatId: z.string().optional(),
      appName: z.string().optional()
    }).optional(),
    custom: z.record(z.any()).optional()
  }).optional()
});

// Template configuration schema
export const TemplateConfigurationSchema = z.object({
  templates: z.array(z.object({
    name: z.string(),
    displayName: z.string(),
    description: z.string(),
    variants: z.array(z.string()),
    supportedContentTypes: z.array(z.string()),
    baseStyles: z.string(),
    variantStyles: z.record(z.string()),
    customProperties: z.record(z.string()).optional(),
    preview: z.string().optional()
  })),
  defaultTemplate: z.string(),
  customTemplatesEnabled: z.boolean(),
  maxCustomCSS: z.number().positive()
});
```

## Template System Architecture

### Template Engine Implementation

```typescript
// templates/TemplateEngine.ts
export class TemplateEngine {
  private templates: Map<string, TemplateDefinition>;
  private cssProcessor: CSSProcessor;
  private variableResolver: VariableResolver;

  constructor(config: TemplateConfiguration) {
    this.templates = new Map();
    this.cssProcessor = new CSSProcessor();
    this.variableResolver = new VariableResolver();
    this.loadTemplates(config);
  }

  async renderTemplate(
    templateConfig: TemplateConfiguration,
    content: ProcessedContent,
    metadata?: ExportMetadata
  ): Promise<RenderedTemplate> {
    const template = this.getTemplate(templateConfig.name);
    const variant = templateConfig.variant || 'default';

    // Build template context
    const context = this.buildTemplateContext(content, metadata, templateConfig);

    // Render HTML structure
    const html = template.renderHTML(context, variant);

    // Compile and merge styles
    const styles = await this.compileStyles(template, templateConfig, variant);

    // Process template variables in HTML
    const processedHTML = this.variableResolver.resolve(html, context);

    // Generate page-specific content
    const pageContent = this.generatePageContent(processedHTML, templateConfig);

    return {
      html: pageContent.html,
      styles: styles,
      headerFooter: pageContent.headerFooter,
      metadata: {
        templateName: templateConfig.name,
        variant: variant,
        renderTime: Date.now(),
        variablesUsed: this.variableResolver.getUsedVariables()
      }
    };
  }

  private buildTemplateContext(
    content: ProcessedContent,
    metadata?: ExportMetadata,
    config?: TemplateConfiguration
  ): TemplateContext {
    const now = new Date();
    
    return {
      // Content
      content: content,
      
      // Metadata
      title: metadata?.appContext?.appName || 'Document',
      author: 'AI Hub Apps',
      subject: this.generateSubject(content),
      keywords: this.extractKeywords(content),
      
      // Timestamps
      timestamp: now.toISOString(),
      dateFormatted: now.toLocaleDateString(),
      timeFormatted: now.toLocaleTimeString(),
      
      // Page variables (resolved during PDF generation)
      pageNumber: '{{pageNumber}}',
      totalPages: '{{totalPages}}',
      
      // Configuration
      template: config,
      
      // Styling helpers
      colors: config?.colors || {},
      typography: config?.typography || {},
      layout: config?.layout || {},
      
      // Content statistics
      stats: {
        wordCount: this.calculateWordCount(content),
        characterCount: this.calculateCharacterCount(content),
        readingTime: this.estimateReadingTime(content)
      },
      
      // Custom variables
      custom: metadata?.custom || {}
    };
  }

  private async compileStyles(
    template: TemplateDefinition,
    config: TemplateConfiguration,
    variant: string
  ): Promise<string> {
    let styles = template.getBaseStyles();
    
    // Add variant-specific styles
    if (template.hasVariant(variant)) {
      styles += '\n' + template.getVariantStyles(variant);
    }
    
    // Process CSS custom properties
    if (config.colors || config.typography || config.layout) {
      const customProperties = this.generateCustomProperties(config);
      styles = `:root {\n${customProperties}\n}\n` + styles;
    }
    
    // Add custom CSS
    if (config.customCSS) {
      const sanitizedCSS = await this.cssProcessor.sanitize(config.customCSS);
      styles += '\n' + sanitizedCSS;
    }
    
    // Minify for production
    return this.cssProcessor.minify(styles);
  }

  private generateCustomProperties(config: TemplateConfiguration): string {
    const properties: string[] = [];
    
    // Colors
    if (config.colors) {
      Object.entries(config.colors).forEach(([key, value]) => {
        properties.push(`  --color-${key}: ${value};`);
      });
    }
    
    // Typography
    if (config.typography) {
      if (config.typography.fontFamily) {
        properties.push(`  --font-family: ${config.typography.fontFamily};`);
      }
      if (config.typography.fontSize) {
        properties.push(`  --font-size-base: ${config.typography.fontSize}px;`);
      }
      if (config.typography.lineHeight) {
        properties.push(`  --line-height: ${config.typography.lineHeight};`);
      }
    }
    
    // Layout
    if (config.layout) {
      if (config.layout.contentWidth) {
        properties.push(`  --content-width: ${config.layout.contentWidth}px;`);
      }
      if (config.layout.spacing) {
        const spacingMap = { tight: '0.75', normal: '1', loose: '1.5' };
        properties.push(`  --spacing-scale: ${spacingMap[config.layout.spacing]};`);
      }
    }
    
    return properties.join('\n');
  }
}
```

### Built-in Template Definitions

```typescript
// templates/base/DefaultTemplate.ts
export class DefaultTemplate implements TemplateDefinition {
  readonly name = 'default';
  readonly displayName = 'Default Template';
  readonly description = 'Clean and professional template suitable for most content types';
  readonly supportedContentTypes = ['html', 'chat', 'mixed', 'svg'];
  readonly variants = ['default', 'compact', 'spacious'];

  renderHTML(context: TemplateContext, variant: string): string {
    const headerHTML = this.renderHeader(context);
    const contentHTML = this.renderContent(context, variant);
    const footerHTML = this.renderFooter(context);

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${context.title}</title>
  <meta name="author" content="${context.author}">
  <meta name="subject" content="${context.subject}">
  <meta name="keywords" content="${context.keywords}">
</head>
<body class="template-default variant-${variant}">
  <div class="document-container">
    ${headerHTML}
    
    <main class="document-content">
      ${contentHTML}
    </main>
    
    ${footerHTML}
    
    ${context.template?.watermark ? this.renderWatermark(context.template.watermark) : ''}
  </div>
</body>
</html>`;
  }

  getBaseStyles(): string {
    return `
/* Default Template Base Styles */
:root {
  --color-primary: var(--color-primary, #2563eb);
  --color-secondary: var(--color-secondary, #64748b);
  --color-text: var(--color-text, #1e293b);
  --color-background: var(--color-background, #ffffff);
  --color-accent: var(--color-accent, #f1f5f9);
  
  --font-family: var(--font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  --font-size-base: var(--font-size-base, 14px);
  --line-height: var(--line-height, 1.6);
  
  --content-width: var(--content-width, 100%);
  --spacing-scale: var(--spacing-scale, 1);
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  line-height: var(--line-height);
  color: var(--color-text);
  background-color: var(--color-background);
}

.document-container {
  max-width: var(--content-width);
  margin: 0 auto;
  padding: calc(20px * var(--spacing-scale));
}

.document-header {
  border-bottom: 2px solid var(--color-accent);
  padding-bottom: calc(20px * var(--spacing-scale));
  margin-bottom: calc(30px * var(--spacing-scale));
}

.document-title {
  font-size: calc(var(--font-size-base) * 2);
  font-weight: 700;
  color: var(--color-primary);
  margin-bottom: calc(5px * var(--spacing-scale));
}

.document-subtitle {
  font-size: calc(var(--font-size-base) * 1.25);
  font-weight: 500;
  color: var(--color-secondary);
  margin-bottom: calc(10px * var(--spacing-scale));
}

.export-metadata {
  font-size: calc(var(--font-size-base) * 0.875);
  color: var(--color-secondary);
}

.document-content {
  line-height: var(--line-height);
}

/* Content type specific styles */
.content-html h1, .content-html h2, .content-html h3,
.content-html h4, .content-html h5, .content-html h6 {
  margin: calc(20px * var(--spacing-scale)) 0 calc(10px * var(--spacing-scale));
  color: var(--color-primary);
}

.content-html p {
  margin-bottom: calc(15px * var(--spacing-scale));
}

.content-html ul, .content-html ol {
  margin: calc(15px * var(--spacing-scale)) 0;
  padding-left: calc(30px * var(--spacing-scale));
}

.content-html blockquote {
  border-left: 4px solid var(--color-accent);
  margin: calc(20px * var(--spacing-scale)) 0;
  padding: calc(10px * var(--spacing-scale)) 0 calc(10px * var(--spacing-scale)) calc(20px * var(--spacing-scale));
  background: var(--color-accent);
  font-style: italic;
}

.content-html code {
  background: var(--color-accent);
  padding: 2px 4px;
  border-radius: 3px;
  font-family: Monaco, Consolas, 'Courier New', monospace;
  font-size: calc(var(--font-size-base) * 0.875);
}

.content-html pre {
  background: var(--color-accent);
  padding: calc(15px * var(--spacing-scale));
  border-radius: 5px;
  overflow-x: auto;
  margin: calc(15px * var(--spacing-scale)) 0;
}

/* Chat content styles */
.chat-message {
  margin-bottom: calc(20px * var(--spacing-scale));
  padding: calc(15px * var(--spacing-scale));
  border-radius: 8px;
  border: 1px solid var(--color-accent);
}

.chat-message.user {
  background-color: #ebf8ff;
  border-left: 4px solid #3182ce;
}

.chat-message.assistant {
  background-color: #f0fff4;
  border-left: 4px solid #38a169;
}

.chat-message-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: calc(8px * var(--spacing-scale));
  font-size: calc(var(--font-size-base) * 0.875);
}

.chat-role {
  font-weight: 600;
  color: var(--color-primary);
}

.chat-timestamp {
  color: var(--color-secondary);
}

/* SVG content styles */
.content-svg {
  text-align: center;
  margin: calc(20px * var(--spacing-scale)) 0;
}

.content-svg svg {
  max-width: 100%;
  height: auto;
}

/* Print styles */
@media print {
  .document-container {
    max-width: none;
    margin: 0;
    padding: 15px;
  }
  
  .chat-message,
  .content-section {
    page-break-inside: avoid;
  }
  
  .document-header {
    page-break-after: avoid;
  }
}

/* Variant styles */
.variant-compact {
  --spacing-scale: 0.75;
  --font-size-base: 12px;
}

.variant-compact .document-container {
  padding: 15px;
}

.variant-spacious {
  --spacing-scale: 1.5;
  --font-size-base: 16px;
}

.variant-spacious .document-container {
  padding: 30px;
}
`;
  }

  getVariantStyles(variant: string): string {
    switch (variant) {
      case 'compact':
        return `
.variant-compact .document-title {
  font-size: calc(var(--font-size-base) * 1.75);
}
.variant-compact .document-subtitle {
  font-size: calc(var(--font-size-base) * 1.125);
}
        `;
      case 'spacious':
        return `
.variant-spacious .document-title {
  font-size: calc(var(--font-size-base) * 2.25);
}
.variant-spacious .document-subtitle {
  font-size: calc(var(--font-size-base) * 1.375);
}
        `;
      default:
        return '';
    }
  }

  hasVariant(variant: string): boolean {
    return this.variants.includes(variant);
  }

  private renderHeader(context: TemplateContext): string {
    return `
<header class="document-header">
  <h1 class="document-title">${context.title}</h1>
  ${context.template?.subtitle ? `<h2 class="document-subtitle">${context.template.subtitle}</h2>` : ''}
  <div class="export-metadata">
    <p>Exported on ${context.dateFormatted} at ${context.timeFormatted}</p>
    ${context.stats.wordCount ? `<p>${context.stats.wordCount} words • ${context.stats.readingTime} min read</p>` : ''}
  </div>
</header>`;
  }

  private renderContent(context: TemplateContext, variant: string): string {
    const contentClass = `content-${context.content.type}`;
    
    switch (context.content.type) {
      case 'html':
        return `<div class="${contentClass}">${context.content.html}</div>`;
      
      case 'chat':
        return this.renderChatContent(context.content as any);
      
      case 'svg':
        return `<div class="${contentClass}">${context.content.svg}</div>`;
      
      case 'mixed':
        return this.renderMixedContent(context.content as any);
      
      default:
        return `<div class="${contentClass}">Unsupported content type: ${context.content.type}</div>`;
    }
  }

  private renderChatContent(content: ChatContent): string {
    return content.messages.map(message => `
<div class="chat-message ${message.role}">
  <div class="chat-message-header">
    <span class="chat-role">${message.role === 'user' ? 'User' : 'Assistant'}</span>
    ${message.timestamp ? `<span class="chat-timestamp">${new Date(message.timestamp).toLocaleString()}</span>` : ''}
  </div>
  <div class="chat-message-content">
    ${message.content}
  </div>
</div>
    `).join('');
  }

  private renderMixedContent(content: MixedContent): string {
    return content.sections.map(section => `
<section class="content-section" id="${section.id}">
  ${section.title ? `<h2 class="section-title">${section.title}</h2>` : ''}
  <div class="section-content">
    ${this.renderContent({ content: section.content } as any, 'default')}
  </div>
</section>
    `).join('');
  }

  private renderFooter(context: TemplateContext): string {
    return `
<footer class="document-footer">
  <div class="footer-content">
    <p>Generated by ${context.author}</p>
    <p>Page {{pageNumber}} of {{totalPages}}</p>
  </div>
</footer>`;
  }

  private renderWatermark(watermark: WatermarkConfiguration): string {
    const positionClass = watermark.position.replace('-', ' ');
    return `
<div class="watermark watermark-${watermark.position}" 
     style="opacity: ${watermark.opacity}; ${watermark.rotation ? `transform: rotate(${watermark.rotation}deg);` : ''}">
  ${watermark.text}
</div>`;
  }
}
```

### Configuration Management

```typescript
// config/ConfigurationManager.ts
export class ConfigurationManager {
  private config: PDFExportConfiguration;
  private validators: Map<string, z.ZodSchema>;

  constructor(configPath?: string) {
    this.validators = new Map();
    this.registerValidators();
    this.loadConfiguration(configPath);
  }

  private registerValidators() {
    this.validators.set('exportRequest', PDFExportRequestSchema);
    this.validators.set('templateConfig', TemplateConfigurationSchema);
  }

  private loadConfiguration(configPath?: string): void {
    const defaultConfig = this.getDefaultConfiguration();
    
    if (configPath && existsSync(configPath)) {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      this.config = this.mergeConfigurations(defaultConfig, userConfig);
    } else {
      this.config = defaultConfig;
    }

    this.validateConfiguration();
  }

  getConfiguration(): PDFExportConfiguration {
    return { ...this.config };
  }

  updateConfiguration(updates: Partial<PDFExportConfiguration>): void {
    this.config = this.mergeConfigurations(this.config, updates);
    this.validateConfiguration();
  }

  validateRequest(request: PDFExportRequest): ValidationResult {
    const validator = this.validators.get('exportRequest');
    const result = validator?.safeParse(request);
    
    if (!result?.success) {
      return {
        isValid: false,
        errors: result?.error.errors.map(err => ({
          code: err.code,
          message: err.message,
          field: err.path.join('.'),
          context: { received: err.received, expected: err.expected }
        })) || [],
        warnings: []
      };
    }

    return { isValid: true, errors: [], warnings: [] };
  }

  private getDefaultConfiguration(): PDFExportConfiguration {
    return {
      service: {
        defaultGenerator: 'jspdf',
        maxConcurrentExports: 3,
        exportTimeout: 60000
      },
      security: {
        sanitizeHTML: true,
        allowedTags: [
          'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'strong', 'em', 'ul', 'ol', 'li', 'a', 'img', 'br',
          'blockquote', 'code', 'pre'
        ],
        allowedAttributes: {
          'a': ['href', 'title'],
          'img': ['src', 'alt', 'width', 'height'],
          '*': ['class', 'id']
        },
        maxContentSize: 1048576, // 1MB
        maxImageDimensions: { width: 2048, height: 2048 }
      },
      performance: {
        maxMemoryUsage: 67108864, // 64MB
        resourceCleanupDelay: 1000,
        enableProgressTracking: true
      },
      templates: {
        defaultTemplate: 'default',
        customTemplatesPath: './templates/custom',
        enableCustomCSS: true
      }
    };
  }
}
```

This configuration and template system provides:

1. **Comprehensive Validation**: Zod schemas for type-safe validation
2. **Flexible Templates**: Plugin-based template system with variants
3. **CSS Custom Properties**: Dynamic styling based on configuration
4. **Security**: Configurable content sanitization and limits
5. **Performance Tuning**: Adjustable memory and processing limits
6. **Extensibility**: Support for custom templates and CSS
7. **Type Safety**: Full TypeScript coverage for all configurations

The system is designed to be easily configurable while maintaining security and performance standards.