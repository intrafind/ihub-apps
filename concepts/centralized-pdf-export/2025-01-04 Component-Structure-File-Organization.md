# Component Structure & File Organization

## File Organization Structure

```
client/src/shared/services/pdf-export/
├── index.ts                          # Main exports and service registration
├── types/                            # TypeScript type definitions
│   ├── index.ts                      # Re-export all types
│   ├── core.ts                       # Core interfaces (IPDFExportService, etc.)
│   ├── content.ts                    # Content type definitions
│   ├── configuration.ts              # Template and export configurations
│   ├── security.ts                   # Security and validation types
│   └── react.ts                      # React-specific types and hooks
├── services/                         # Core service implementations
│   ├── PDFExportService.ts           # Main orchestration service
│   ├── ValidationService.ts          # Input validation and security
│   ├── TemplateService.ts            # Template management and rendering
│   └── ResourceManager.ts            # Resource cleanup and memory management
├── processors/                       # Content type processors
│   ├── index.ts                      # Processor registry
│   ├── BaseProcessor.ts              # Abstract base processor
│   ├── HTMLProcessor.ts              # HTML/text content processor
│   ├── SVGProcessor.ts               # SVG diagram processor
│   ├── CanvasProcessor.ts            # Canvas element processor
│   ├── ChatProcessor.ts              # Chat conversation processor
│   └── MixedProcessor.ts             # Mixed content processor
├── generators/                       # PDF generation engines
│   ├── index.ts                      # Generator registry and factory
│   ├── BaseGenerator.ts              # Abstract base generator
│   ├── JSPDFGenerator.ts             # jsPDF-based generator
│   ├── HTMLPrintGenerator.ts         # Browser print API generator
│   └── CanvasGenerator.ts            # Canvas-based generator
├── templates/                        # Template system
│   ├── index.ts                      # Template registry
│   ├── TemplateEngine.ts             # Template processing engine
│   ├── base/                         # Base template definitions
│   │   ├── DefaultTemplate.ts        # Default template
│   │   ├── ProfessionalTemplate.ts   # Professional template
│   │   └── MinimalTemplate.ts        # Minimal template
│   └── styles/                       # CSS and styling
│       ├── base.css                  # Base styles
│       ├── professional.css          # Professional theme
│       ├── minimal.css               # Minimal theme
│       └── variables.css             # CSS custom properties
├── security/                         # Security and validation
│   ├── index.ts                      # Security service exports
│   ├── HTMLSanitizer.ts              # HTML content sanitization
│   ├── ContentValidator.ts           # Content validation
│   ├── SchemaValidator.ts            # Zod schema validation
│   └── SecurityPolicies.ts           # Security policy definitions
├── utils/                            # Utility functions
│   ├── index.ts                      # Utility exports
│   ├── contentUtils.ts               # Content processing utilities
│   ├── formatUtils.ts                # Format conversion utilities
│   ├── performanceUtils.ts           # Performance monitoring utilities
│   └── errorUtils.ts                 # Error handling utilities
├── hooks/                            # React hooks
│   ├── index.ts                      # Hook exports
│   ├── usePDFExport.ts               # Main PDF export hook
│   ├── useExportProgress.ts          # Export progress tracking
│   └── useExportCapabilities.ts      # Service capabilities hook
├── components/                       # React components
│   ├── index.ts                      # Component exports
│   ├── providers/                    # Context providers
│   │   └── PDFExportProvider.tsx     # Main context provider
│   ├── ui/                           # UI components
│   │   ├── UnifiedExportButton.tsx   # Standardized export button
│   │   ├── ExportDialog.tsx          # Export configuration dialog
│   │   ├── ExportProgressDialog.tsx  # Progress feedback dialog
│   │   ├── TemplateSelector.tsx      # Template selection component
│   │   └── FormatSelector.tsx        # Format selection component
│   └── legacy/                       # Legacy component adapters
│       ├── ChatExportAdapter.tsx     # Chat export compatibility
│       ├── CanvasExportAdapter.tsx   # Canvas export compatibility
│       └── MermaidExportAdapter.tsx  # Mermaid export compatibility
├── config/                           # Configuration files
│   ├── index.ts                      # Configuration exports
│   ├── defaultConfig.ts              # Default service configuration
│   ├── securityConfig.ts             # Security configuration
│   ├── templateConfig.ts             # Template configuration
│   └── performanceConfig.ts          # Performance tuning configuration
└── __tests__/                        # Test files
    ├── services/                     # Service tests
    ├── processors/                   # Processor tests
    ├── generators/                   # Generator tests
    ├── components/                   # Component tests
    ├── hooks/                        # Hook tests
    └── integration/                  # Integration tests
```

## Core Service Implementation

### Main Export Service

```typescript
// services/PDFExportService.ts
import { IPDFExportService, PDFExportRequest, PDFExportResult } from '../types';
import { ValidationService } from './ValidationService';
import { TemplateService } from './TemplateService';
import { ResourceManager } from './ResourceManager';
import { ProcessorRegistry } from '../processors';
import { GeneratorRegistry } from '../generators';

/**
 * Main PDF Export Service Implementation
 * Orchestrates the entire PDF export process
 */
export class PDFExportService implements IPDFExportService {
  private validationService: ValidationService;
  private templateService: TemplateService;
  private resourceManager: ResourceManager;
  private processorRegistry: ProcessorRegistry;
  private generatorRegistry: GeneratorRegistry;
  
  constructor(config: PDFExportConfiguration) {
    this.validationService = new ValidationService(config.security);
    this.templateService = new TemplateService(config.templates);
    this.resourceManager = new ResourceManager(config.performance);
    this.processorRegistry = new ProcessorRegistry();
    this.generatorRegistry = new GeneratorRegistry();
  }

  async export(request: PDFExportRequest): Promise<PDFExportResult> {
    const startTime = Date.now();
    const exportId = request.exportId || this.generateExportId();
    
    try {
      // Phase 1: Validation
      const validation = this.validateRequest(request);
      if (!validation.isValid) {
        throw new ExportError('validation', 'Request validation failed', {
          errors: validation.errors
        });
      }

      // Phase 2: Content Processing
      const processor = this.processorRegistry.getProcessor(request.content.type);
      const processedContent = await processor.process(
        request.content,
        request.security
      );

      // Phase 3: Template Application
      const template = await this.templateService.renderTemplate(
        request.template,
        processedContent,
        request.metadata
      );

      // Phase 4: PDF Generation
      const generator = this.generatorRegistry.getGenerator(
        this.selectOptimalGenerator(request)
      );
      
      const result = await generator.generate(template, request.options);

      // Phase 5: Resource Cleanup
      await this.resourceManager.cleanup(exportId);

      return {
        success: true,
        filename: result.filename,
        fileSize: result.fileSize,
        duration: Date.now() - startTime,
        pageCount: result.pageCount,
        metadata: result.metadata
      };

    } catch (error) {
      await this.resourceManager.cleanup(exportId);
      throw this.handleExportError(error, exportId);
    }
  }

  validateRequest(request: PDFExportRequest): ValidationResult {
    return this.validationService.validate(request);
  }

  getCapabilities(): PDFExportCapabilities {
    return {
      contentTypes: this.processorRegistry.getSupportedTypes(),
      templates: this.templateService.getAvailableTemplates(),
      formats: this.generatorRegistry.getSupportedFormats(),
      features: this.getFeatureFlags(),
      limits: this.getServiceLimits()
    };
  }

  async cancelExport(exportId: string): Promise<boolean> {
    return this.resourceManager.cancelOperation(exportId);
  }

  private selectOptimalGenerator(request: PDFExportRequest): string {
    // Logic to select the best generator based on content type and options
    const contentType = request.content.type;
    const hasComplexLayout = request.template.layout?.complexity === 'high';
    
    if (contentType === 'svg' || contentType === 'canvas') {
      return 'jspdf'; // Better for precise graphics
    }
    
    if (contentType === 'html' && hasComplexLayout) {
      return 'html-print'; // Better for complex layouts
    }
    
    return 'jspdf'; // Default choice
  }
}
```

### Content Processor Architecture

```typescript
// processors/BaseProcessor.ts
export abstract class BaseProcessor<T extends ExportContent> {
  abstract readonly contentType: string;
  
  abstract process(
    content: T,
    security?: SecurityConfiguration
  ): Promise<ProcessedContent>;
  
  protected async sanitizeContent(
    content: string,
    options: SecurityConfiguration
  ): Promise<string> {
    // Common sanitization logic
  }
  
  protected validateContentSize(content: string, maxSize: number): void {
    if (content.length > maxSize) {
      throw new ValidationError('content_too_large', 
        `Content exceeds maximum size of ${maxSize} bytes`);
    }
  }
}

// processors/HTMLProcessor.ts
export class HTMLProcessor extends BaseProcessor<HTMLContent> {
  readonly contentType = 'html';
  
  async process(
    content: HTMLContent,
    security?: SecurityConfiguration
  ): Promise<ProcessedContent> {
    // Validate content size
    this.validateContentSize(content.html, security?.limits?.maxHTMLSize || 1024000);
    
    // Sanitize HTML content
    const sanitizedHTML = await this.sanitizeContent(content.html, security);
    
    // Process relative URLs
    const processedHTML = this.processUrls(sanitizedHTML, content.baseUrl);
    
    // Extract and process styles
    const processedStyles = this.processStyles(content.styles);
    
    return {
      type: 'html',
      html: processedHTML,
      styles: processedStyles,
      metadata: {
        wordCount: this.countWords(processedHTML),
        imageCount: this.countImages(processedHTML)
      }
    };
  }

  private processUrls(html: string, baseUrl?: string): string {
    // Implementation for processing relative URLs
  }

  private processStyles(styles?: string): string {
    // Implementation for processing and validating CSS
  }
}
```

### Template System

```typescript
// templates/TemplateEngine.ts
export class TemplateEngine {
  private templateRegistry: Map<string, TemplateDefinition>;
  
  constructor() {
    this.templateRegistry = new Map();
    this.registerDefaultTemplates();
  }

  async renderTemplate(
    config: TemplateConfiguration,
    content: ProcessedContent,
    metadata?: ExportMetadata
  ): Promise<RenderedTemplate> {
    const template = this.getTemplate(config.name);
    
    // Apply template variables
    const templateVars = this.buildTemplateVariables(content, metadata, config);
    
    // Render HTML structure
    const htmlStructure = template.render(templateVars);
    
    // Apply styles
    const styles = this.compileStyles(template, config);
    
    // Generate header/footer if configured
    const headerFooter = this.renderHeaderFooter(config, templateVars);
    
    return {
      html: htmlStructure,
      styles: styles,
      headerFooter: headerFooter,
      metadata: {
        templateName: config.name,
        renderTime: Date.now()
      }
    };
  }

  private buildTemplateVariables(
    content: ProcessedContent,
    metadata?: ExportMetadata,
    config?: TemplateConfiguration
  ): TemplateVariables {
    return {
      content: content,
      timestamp: new Date().toISOString(),
      pageNumber: '{{pageNumber}}',
      totalPages: '{{totalPages}}',
      title: metadata?.appContext?.appName || 'Document',
      author: 'AI Hub Apps',
      ...config?.customVariables
    };
  }
}

// templates/base/DefaultTemplate.ts
export class DefaultTemplate implements TemplateDefinition {
  readonly name = 'default';
  readonly displayName = 'Default Template';
  readonly supportedContentTypes = ['html', 'chat', 'mixed'];

  render(variables: TemplateVariables): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${variables.title}</title>
  <style>
    ${this.getBaseStyles()}
    ${variables.customStyles || ''}
  </style>
</head>
<body>
  <div class="document-container">
    <header class="document-header">
      <h1>${variables.title}</h1>
      <p class="export-date">Exported on ${variables.timestamp}</p>
    </header>
    
    <main class="document-content">
      ${variables.content.html}
    </main>
    
    ${variables.watermark ? `<div class="watermark">${variables.watermark}</div>` : ''}
  </div>
</body>
</html>
    `;
  }

  private getBaseStyles(): string {
    // Return base CSS styles for the template
  }
}
```

### React Components

```typescript
// components/ui/UnifiedExportButton.tsx
interface UnifiedExportButtonProps {
  content: ExportContent;
  options?: Partial<ExportOptions>;
  template?: Partial<TemplateConfiguration>;
  onExportStart?: (exportId: string) => void;
  onExportComplete?: (result: PDFExportResult) => void;
  onExportError?: (error: ExportError) => void;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export const UnifiedExportButton: React.FC<UnifiedExportButtonProps> = ({
  content,
  options = {},
  template = {},
  onExportStart,
  onExportComplete,
  onExportError,
  disabled = false,
  children = 'Export PDF',
  className = ''
}) => {
  const { exportToPDF, status, progress, error } = usePDFExport();
  const [showDialog, setShowDialog] = useState(false);

  const handleExport = useCallback(async () => {
    try {
      const exportId = generateExportId();
      onExportStart?.(exportId);

      const request: PDFExportRequest = {
        exportId,
        content,
        options: {
          format: 'A4',
          orientation: 'portrait',
          margins: { top: 20, right: 20, bottom: 20, left: 20 },
          ...options
        },
        template: {
          name: 'default',
          variant: 'default',
          ...template
        }
      };

      const result = await exportToPDF(request);
      onExportComplete?.(result);
    } catch (err) {
      const exportError = err as ExportError;
      onExportError?.(exportError);
    }
  }, [content, options, template, exportToPDF, onExportStart, onExportComplete, onExportError]);

  const isExporting = status === 'processing' || status === 'generating';

  return (
    <>
      <button
        onClick={() => setShowDialog(true)}
        disabled={disabled || isExporting}
        className={`
          pdf-export-button
          ${isExporting ? 'exporting' : ''}
          ${className}
        `}
      >
        {isExporting ? (
          <>
            <Spinner size="sm" />
            Exporting... ({progress}%)
          </>
        ) : (
          <>
            <FileTextIcon size="sm" />
            {children}
          </>
        )}
      </button>

      {showDialog && (
        <ExportDialog
          isOpen={showDialog}
          onClose={() => setShowDialog(false)}
          onExport={handleExport}
          defaultOptions={options}
          defaultTemplate={template}
          contentType={content.type}
        />
      )}
    </>
  );
};

// hooks/usePDFExport.ts
export const usePDFExport = (): UsePDFExportResult => {
  const context = useContext(PDFExportContext);
  if (!context) {
    throw new Error('usePDFExport must be used within PDFExportProvider');
  }

  const [currentOperation, setCurrentOperation] = useState<ExportOperation | null>(null);

  const exportToPDF = useCallback(async (request: PDFExportRequest) => {
    const operation: ExportOperation = {
      id: request.exportId || generateExportId(),
      status: 'pending',
      progress: 0,
      currentStep: 'Initializing...',
      startTime: Date.now()
    };

    setCurrentOperation(operation);

    try {
      // Update progress through the export process
      const updateProgress = (progress: number, step: string) => {
        setCurrentOperation(prev => prev ? {
          ...prev,
          progress,
          currentStep: step,
          status: progress === 100 ? 'completed' : 'processing'
        } : null);
      };

      const result = await context.exportService.export(request, updateProgress);
      
      setCurrentOperation(prev => prev ? {
        ...prev,
        status: 'completed',
        progress: 100,
        currentStep: 'Export completed'
      } : null);

      return result;
    } catch (error) {
      setCurrentOperation(prev => prev ? {
        ...prev,
        status: 'failed',
        currentStep: `Export failed: ${error.message}`
      } : null);
      throw error;
    }
  }, [context.exportService]);

  return {
    exportToPDF,
    status: currentOperation?.status || 'pending',
    progress: currentOperation?.progress || 0,
    currentStep: currentOperation?.currentStep || '',
    error: currentOperation?.status === 'failed' ? new ExportError('export_failed', currentOperation.currentStep) : null,
    cancel: () => context.cancelExport(currentOperation?.id || ''),
    reset: () => setCurrentOperation(null),
    capabilities: context.exportService.getCapabilities()
  };
};
```

This component structure provides:

1. **Separation of Concerns**: Clear separation between services, processors, generators, and UI
2. **Extensibility**: Plugin-based architecture for easy addition of new content types and templates
3. **Type Safety**: Full TypeScript coverage with proper type definitions
4. **Testability**: Modular design with clear interfaces for unit testing
5. **Performance**: Resource management and cleanup utilities
6. **React Integration**: Context providers, hooks, and components for seamless React integration
7. **Legacy Support**: Adapter components for backward compatibility

The file organization follows React best practices and makes it easy for junior developers to understand and extend the system.