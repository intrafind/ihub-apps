# PDF Export API Design & TypeScript Interfaces

## Core API Interface

### Main Export Service Interface

```typescript
/**
 * Main PDF Export Service Interface
 * Provides unified API for all PDF export operations
 */
interface IPDFExportService {
  /**
   * Export content to PDF with specified options
   * @param request - Export request with content and configuration
   * @returns Promise with export result
   */
  export(request: PDFExportRequest): Promise<PDFExportResult>;
  
  /**
   * Validate export request before processing
   * @param request - Export request to validate
   * @returns Validation result with errors if any
   */
  validateRequest(request: PDFExportRequest): ValidationResult;
  
  /**
   * Get available templates and content type processors
   * @returns Configuration metadata
   */
  getCapabilities(): PDFExportCapabilities;
  
  /**
   * Cancel ongoing export operation
   * @param exportId - Unique export identifier
   * @returns Cancel result
   */
  cancelExport(exportId: string): Promise<boolean>;
}
```

### Request/Response Types

```typescript
/**
 * Main export request interface
 */
interface PDFExportRequest {
  /** Unique identifier for this export operation */
  exportId?: string;
  
  /** Content to export */
  content: ExportContent;
  
  /** Export configuration */
  options: ExportOptions;
  
  /** Template and styling configuration */
  template: TemplateConfiguration;
  
  /** Security and validation settings */
  security?: SecurityConfiguration;
  
  /** Metadata for the export */
  metadata?: ExportMetadata;
}

/**
 * Export result interface
 */
interface PDFExportResult {
  /** Success status */
  success: boolean;
  
  /** Generated filename */
  filename: string;
  
  /** File size in bytes */
  fileSize: number;
  
  /** Export duration in milliseconds */
  duration: number;
  
  /** Number of pages generated */
  pageCount: number;
  
  /** Error details if export failed */
  error?: ExportError;
  
  /** Warnings or notices */
  warnings?: string[];
  
  /** Export metadata */
  metadata?: ExportResultMetadata;
}
```

### Content Type Definitions

```typescript
/**
 * Union type for different content types
 */
type ExportContent = 
  | HTMLContent 
  | SVGContent 
  | CanvasContent 
  | ChatContent 
  | MixedContent;

/**
 * HTML/Text content for export
 */
interface HTMLContent {
  type: 'html';
  html: string;
  /** CSS styles to apply */
  styles?: string;
  /** Base URL for relative resources */
  baseUrl?: string;
}

/**
 * SVG diagram content
 */
interface SVGContent {
  type: 'svg';
  svg: string;
  /** SVG dimensions */
  dimensions?: {
    width: number;
    height: number;
  };
  /** Background color */
  backgroundColor?: string;
}

/**
 * Canvas element content
 */
interface CanvasContent {
  type: 'canvas';
  /** Canvas element or data URL */
  canvas: HTMLCanvasElement | string;
  /** Image format (png, jpeg) */
  format?: 'png' | 'jpeg';
  /** Image quality (0-1) */
  quality?: number;
}

/**
 * Chat conversation content
 */
interface ChatContent {
  type: 'chat';
  messages: ChatMessage[];
  /** Chat metadata */
  chatInfo?: {
    appName?: string;
    model?: string;
    settings?: Record<string, any>;
  };
}

/**
 * Mixed content document
 */
interface MixedContent {
  type: 'mixed';
  sections: ContentSection[];
  /** Table of contents configuration */
  toc?: TOCConfiguration;
}

/**
 * Individual chat message
 */
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number | string;
  metadata?: Record<string, any>;
}

/**
 * Section in mixed content document
 */
interface ContentSection {
  id: string;
  title?: string;
  content: ExportContent;
  /** Section-specific options */
  options?: Partial<ExportOptions>;
}
```

### Configuration Interfaces

```typescript
/**
 * Export options configuration
 */
interface ExportOptions {
  /** PDF page format */
  format?: 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid' | [number, number];
  
  /** Page orientation */
  orientation?: 'portrait' | 'landscape';
  
  /** Page margins (in mm) */
  margins?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  
  /** PDF quality settings */
  quality?: {
    /** Image compression (0-1) */
    imageCompression: number;
    /** Enable PDF compression */
    compress: boolean;
    /** DPI for image rendering */
    dpi: number;
  };
  
  /** Header/footer configuration */
  headerFooter?: {
    header?: HeaderFooterContent;
    footer?: HeaderFooterContent;
  };
  
  /** Watermark configuration */
  watermark?: WatermarkConfiguration;
  
  /** Security settings */
  security?: PDFSecuritySettings;
}

/**
 * Template configuration
 */
interface TemplateConfiguration {
  /** Template name/identifier */
  name: string;
  
  /** Template variant */
  variant?: 'default' | 'professional' | 'minimal' | 'corporate';
  
  /** Custom CSS overrides */
  customCSS?: string;
  
  /** Typography settings */
  typography?: {
    fontFamily?: string;
    fontSize?: number;
    lineHeight?: number;
    headingScale?: number;
  };
  
  /** Color scheme */
  colors?: {
    primary?: string;
    secondary?: string;
    text?: string;
    background?: string;
    accent?: string;
  };
  
  /** Layout settings */
  layout?: {
    contentWidth?: number;
    spacing?: 'tight' | 'normal' | 'loose';
    alignment?: 'left' | 'center' | 'justify';
  };
}

/**
 * Header/footer content
 */
interface HeaderFooterContent {
  /** Content template with placeholders */
  template: string;
  
  /** Height in mm */
  height?: number;
  
  /** Show on first page */
  showOnFirstPage?: boolean;
  
  /** Custom styles */
  styles?: string;
}

/**
 * Watermark configuration
 */
interface WatermarkConfiguration {
  /** Watermark text */
  text: string;
  
  /** Position on page */
  position: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'bottom-center';
  
  /** Opacity (0-1) */
  opacity: number;
  
  /** Rotation angle in degrees */
  rotation?: number;
  
  /** Font settings */
  font?: {
    size: number;
    family?: string;
    color?: string;
  };
}

/**
 * PDF security settings
 */
interface PDFSecuritySettings {
  /** Restrict printing */
  restrictPrinting?: boolean;
  
  /** Restrict copying */
  restrictCopying?: boolean;
  
  /** Restrict editing */
  restrictEditing?: boolean;
  
  /** User password */
  userPassword?: string;
  
  /** Owner password */
  ownerPassword?: string;
}
```

### Security and Validation

```typescript
/**
 * Security configuration
 */
interface SecurityConfiguration {
  /** Enable HTML sanitization */
  sanitizeHTML: boolean;
  
  /** HTML sanitization options */
  sanitizationOptions?: {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[]>;
    allowedSchemes?: string[];
  };
  
  /** Content size limits */
  limits?: {
    /** Maximum HTML content size (bytes) */
    maxHTMLSize: number;
    /** Maximum SVG size (bytes) */
    maxSVGSize: number;
    /** Maximum image dimensions */
    maxImageDimensions: { width: number; height: number };
    /** Maximum number of pages */
    maxPages: number;
  };
  
  /** Resource validation */
  resourceValidation?: {
    /** Validate external URLs */
    validateUrls: boolean;
    /** Allowed URL schemes */
    allowedSchemes: string[];
  };
}

/**
 * Validation result
 */
interface ValidationResult {
  /** Is request valid */
  isValid: boolean;
  
  /** Validation errors */
  errors: ValidationError[];
  
  /** Validation warnings */
  warnings: ValidationWarning[];
}

/**
 * Validation error
 */
interface ValidationError {
  /** Error code */
  code: string;
  
  /** Human-readable message */
  message: string;
  
  /** Field path that caused error */
  field?: string;
  
  /** Additional error context */
  context?: Record<string, any>;
}

/**
 * Validation warning
 */
interface ValidationWarning {
  /** Warning code */
  code: string;
  
  /** Human-readable message */
  message: string;
  
  /** Field that triggered warning */
  field?: string;
}
```

### Service Capabilities and Metadata

```typescript
/**
 * Service capabilities
 */
interface PDFExportCapabilities {
  /** Supported content types */
  contentTypes: string[];
  
  /** Available templates */
  templates: TemplateInfo[];
  
  /** Available formats */
  formats: PageFormat[];
  
  /** Feature flags */
  features: {
    watermarks: boolean;
    headerFooter: boolean;
    security: boolean;
    customTemplates: boolean;
    mixedContent: boolean;
  };
  
  /** Performance limits */
  limits: {
    maxFileSize: number;
    maxPages: number;
    maxDimensions: { width: number; height: number };
    timeoutMs: number;
  };
}

/**
 * Template information
 */
interface TemplateInfo {
  name: string;
  displayName: string;
  description: string;
  variants: string[];
  supportedContentTypes: string[];
  preview?: string;
}

/**
 * Page format definition
 */
interface PageFormat {
  name: string;
  displayName: string;
  dimensions: { width: number; height: number };
  units: 'mm' | 'in' | 'pt';
}

/**
 * Export metadata
 */
interface ExportMetadata {
  /** Export timestamp */
  timestamp: number;
  
  /** User identifier */
  userId?: string;
  
  /** Application context */
  appContext?: {
    appId?: string;
    chatId?: string;
    appName?: string;
  };
  
  /** Custom metadata */
  custom?: Record<string, any>;
}

/**
 * Export result metadata
 */
interface ExportResultMetadata {
  /** Processing statistics */
  stats: {
    /** Content processing time (ms) */
    contentProcessingTime: number;
    /** Template rendering time (ms) */
    templateRenderingTime: number;
    /** PDF generation time (ms) */
    pdfGenerationTime: number;
    /** Total processing time (ms) */
    totalTime: number;
  };
  
  /** Resource usage */
  resources: {
    /** Peak memory usage (bytes) */
    peakMemoryUsage: number;
    /** Images processed */
    imagesProcessed: number;
    /** External resources loaded */
    externalResources: number;
  };
  
  /** Generated content info */
  contentInfo: {
    /** Word count (for text content) */
    wordCount?: number;
    /** Character count */
    characterCount?: number;
    /** Image count */
    imageCount: number;
  };
}

/**
 * Export error details
 */
interface ExportError {
  /** Error code */
  code: string;
  
  /** Error message */
  message: string;
  
  /** Error category */
  category: 'validation' | 'processing' | 'generation' | 'system';
  
  /** Technical details */
  details?: Record<string, any>;
  
  /** Stack trace (development only) */
  stack?: string;
  
  /** Suggested actions */
  suggestions?: string[];
}

/**
 * Table of contents configuration
 */
interface TOCConfiguration {
  /** Include table of contents */
  enabled: boolean;
  
  /** TOC title */
  title?: string;
  
  /** Maximum heading level to include */
  maxLevel: number;
  
  /** Include page numbers */
  includePageNumbers: boolean;
  
  /** TOC position */
  position: 'beginning' | 'end';
}
```

## React Hooks and Context

```typescript
/**
 * PDF Export React Context
 */
interface PDFExportContextValue {
  /** Export service instance */
  exportService: IPDFExportService;
  
  /** Current export operations */
  activeExports: Map<string, ExportOperation>;
  
  /** Export content to PDF */
  exportToPDF: (request: PDFExportRequest) => Promise<PDFExportResult>;
  
  /** Cancel export */
  cancelExport: (exportId: string) => Promise<boolean>;
  
  /** Get export status */
  getExportStatus: (exportId: string) => ExportStatus | undefined;
}

/**
 * Export operation status
 */
interface ExportOperation {
  /** Operation ID */
  id: string;
  
  /** Current status */
  status: ExportStatus;
  
  /** Progress percentage (0-100) */
  progress: number;
  
  /** Current step description */
  currentStep: string;
  
  /** Start time */
  startTime: number;
  
  /** Estimated completion time */
  estimatedCompletion?: number;
}

/**
 * Export status enum
 */
type ExportStatus = 
  | 'pending'
  | 'validating'
  | 'processing'
  | 'rendering'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Custom hook for PDF export
 */
interface UsePDFExportResult {
  /** Export function */
  exportToPDF: (request: PDFExportRequest) => Promise<PDFExportResult>;
  
  /** Current export status */
  status: ExportStatus;
  
  /** Export progress (0-100) */
  progress: number;
  
  /** Current step description */
  currentStep: string;
  
  /** Export error if any */
  error: ExportError | null;
  
  /** Cancel current export */
  cancel: () => Promise<boolean>;
  
  /** Reset export state */
  reset: () => void;
  
  /** Export capabilities */
  capabilities: PDFExportCapabilities;
}
```

This comprehensive API design provides:

1. **Type Safety**: Full TypeScript coverage for all interfaces
2. **Extensibility**: Plugin-based architecture for content types and templates
3. **Security**: Built-in validation and sanitization options
4. **Performance**: Progress tracking and cancellation support
5. **Flexibility**: Configurable templates, formats, and security settings
6. **React Integration**: Context and hooks for seamless React integration

The interfaces are designed to be backward-compatible with existing implementations while providing a clean migration path to the new unified system.