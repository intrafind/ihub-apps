# UI/UX Brief: iFinder Document Browser

## Executive Summary

The iFinder Document Browser is a sophisticated standalone React component that provides an intuitive, accessible, and high-performance interface for discovering, filtering, and selecting documents within iHub Apps. The design leverages iHub's established design system while introducing specialized patterns for document browsing workflows.

**Key Design Goals:**
- Create a modern, enterprise-grade document discovery experience
- Ensure seamless integration with iHub's existing visual identity
- Maximize accessibility and keyboard navigation support
- Optimize for both novice and power users
- Support efficient bulk operations and source integration

## Component Hierarchy

### Primary Layout Structure

```
IFinderDocumentBrowser (Root Container)
├── DocumentBrowserHeader
│   ├── BrandingSection
│   ├── SearchBar
│   │   ├── SearchInput (with auto-complete)
│   │   ├── SearchSuggestionsDropdown
│   │   └── SearchHistoryButton
│   ├── SearchProfileSelector
│   ├── ViewModeToggle
│   └── QuickActionToolbar
├── DocumentBrowserLayout (Flex Container)
│   ├── DocumentBrowserSidebar (Collapsible)
│   │   ├── FilterAccordion
│   │   │   ├── DocumentTypeFilter
│   │   │   ├── DateRangeFilter
│   │   │   ├── AuthorFilter
│   │   │   ├── SizeFilter
│   │   │   ├── MetadataFilter
│   │   │   └── ActiveFiltersChip
│   │   ├── SelectionBasket
│   │   └── SavedSearchesPanel
│   └── DocumentBrowserMain
│       ├── ResultsHeader
│       │   ├── ResultsCount
│       │   ├── SortingControls
│       │   └── BulkActionToolbar
│       ├── DocumentGrid (Virtual Scrolling)
│       │   └── DocumentCard[]
│       ├── DocumentList (Alternative View)
│       │   └── DocumentRow[]
│       └── LoadingPlaceholder / EmptyState
├── DocumentPreviewModal
├── SelectionConfirmationModal
└── GlobalNotificationToast
```

### Core Components Specification

#### DocumentBrowserHeader
- **Purpose**: Primary navigation and search interface
- **States**: 
  - Default: Clean, focused search interface
  - Searching: Loading indicators and suggestions active
  - Results: Results count and action buttons visible
  - Error: Error state with retry options
- **Props**:
  - `searchQuery` (string): Current search term
  - `searchProfile` (string): Active search profile
  - `viewMode` ('grid' | 'list'): Current view mode
  - `onSearch` (function): Search callback
  - `onViewModeChange` (function): View mode toggle callback
  - `showAdvancedOptions` (boolean): Show/hide advanced controls
- **Accessibility**:
  - ARIA: role="banner", aria-label="Document browser header"
  - Keyboard: Tab navigation, Enter to search, Esc to clear
  - Screen Reader: Search status announcements, result count updates

#### SearchBar
- **Purpose**: Main search input with intelligent suggestions
- **States**:
  - Idle: Placeholder text and search icon
  - Focused: Expanded with suggestions dropdown
  - Typing: Real-time suggestions and auto-complete
  - Loading: Search in progress indicator
  - Results: Search term highlighted, clear button visible
- **Props**:
  - `value` (string): Search input value
  - `placeholder` (string): Localized placeholder text
  - `suggestions` (array): Auto-complete suggestions
  - `history` (array): Previous search queries
  - `onSearch` (function): Search execution callback
  - `onSuggestionSelect` (function): Suggestion selection callback
- **Accessibility**:
  - ARIA: role="combobox", aria-expanded, aria-autocomplete="list"
  - Keyboard: Arrow keys for suggestion navigation, Tab to accept
  - Screen Reader: Search suggestions announced, result updates

#### DocumentCard (Grid View)
- **Purpose**: Visual document representation with metadata
- **States**:
  - Default: Basic document info and thumbnail
  - Hover: Preview tooltip and action buttons
  - Selected: Visual selection indicator
  - Loading: Skeleton loading state
  - Error: Error state with retry option
- **Props**:
  - `document` (DocumentSummary): Document data
  - `isSelected` (boolean): Selection state
  - `viewMode` ('compact' | 'detailed'): Card density
  - `onSelect` (function): Selection callback
  - `onPreview` (function): Preview callback
  - `showThumbnail` (boolean): Thumbnail visibility
- **Accessibility**:
  - ARIA: role="button", aria-selected, aria-describedby for metadata
  - Keyboard: Enter/Space to select, Tab navigation
  - Screen Reader: Document title, type, author, and selection state

#### FilterAccordion
- **Purpose**: Collapsible filter panel with faceted search
- **States**:
  - Collapsed: Filter category headers only
  - Expanded: Full filter options visible
  - Loading: Loading state for facet data
  - Applied: Active filters highlighted
- **Props**:
  - `filters` (FilterState): Current filter state
  - `facets` (FilterFacets): Available filter options
  - `isCollapsed` (boolean): Panel collapse state
  - `onFilterChange` (function): Filter update callback
  - `onClearAll` (function): Clear filters callback
- **Accessibility**:
  - ARIA: role="region", aria-expanded, aria-controls
  - Keyboard: Enter/Space to toggle, arrow keys within filters
  - Screen Reader: Filter count announcements, clear instructions

#### SelectionBasket (Drag & Drop Target)
- **Purpose**: Visual collection area for selected documents
- **States**:
  - Empty: Helpful instructions and drop zone
  - Populated: Selected document thumbnails
  - Dragging: Visual drop zone highlighting
  - Full: Maximum selection warning
- **Props**:
  - `selectedDocuments` (array): Currently selected documents
  - `maxSelection` (number): Maximum allowed selections
  - `allowReorder` (boolean): Enable drag reordering
  - `onRemoveDocument` (function): Remove document callback
  - `onReorder` (function): Reorder callback
- **Accessibility**:
  - ARIA: role="region", aria-label="Selected documents"
  - Keyboard: Delete key to remove, arrow keys to reorder
  - Screen Reader: Selection count, reorder instructions

## Visual Design Specifications

### Color Palette Integration

Building on iHub's existing color scheme with document-specific enhancements:

```css
/* Primary Brand Colors (from iHub) */
--primary-blue: rgb(0, 53, 87);
--primary-gradient: linear-gradient(135deg, rgb(0, 53, 87), #1e40af);

/* Document Browser Specific Colors */
--document-card-bg: #ffffff;
--document-card-border: #e5e7eb;
--document-card-hover: #f8fafc;
--document-card-selected: #eff6ff;
--document-card-selected-border: #3b82f6;

/* Filter Panel Colors */
--filter-panel-bg: #fafafa;
--filter-panel-border: #e5e7eb;
--filter-active: #dbeafe;
--filter-active-border: #3b82f6;

/* Status and Feedback Colors */
--success-light: #dcfce7;
--success-border: #16a34a;
--warning-light: #fef3c7;
--warning-border: #d97706;
--error-light: #fee2e2;
--error-border: #dc2626;

/* Document Type Colors */
--doc-pdf: #dc2626;
--doc-word: #2563eb;
--doc-excel: #16a34a;
--doc-powerpoint: #ea580c;
--doc-text: #6b7280;
--doc-image: #7c3aed;
--doc-archive: #374151;
```

### Typography Hierarchy

Consistent with iHub's Inter font family:

```css
/* Header Typography */
.browser-title {
  font-family: 'Inter', sans-serif;
  font-size: 2.5rem;
  font-weight: 700;
  line-height: 1.2;
  color: var(--primary-blue);
}

.browser-subtitle {
  font-family: 'Inter', sans-serif;
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.5;
  color: #6b7280;
}

/* Document Typography */
.document-title {
  font-family: 'Inter', sans-serif;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
  color: #111827;
}

.document-metadata {
  font-family: 'Inter', sans-serif;
  font-size: 0.875rem;
  font-weight: 400;
  line-height: 1.4;
  color: #6b7280;
}

.document-snippet {
  font-family: 'Inter', sans-serif;
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.5;
  color: #4b5563;
}

/* Filter Typography */
.filter-heading {
  font-family: 'Inter', sans-serif;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.3;
  color: #374151;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.filter-option {
  font-family: 'Inter', sans-serif;
  font-size: 0.875rem;
  font-weight: 400;
  line-height: 1.4;
  color: #4b5563;
}
```

### Spacing System (4px Grid)

Following iHub's established spacing tokens:

```css
/* Base spacing unit: 4px */
--spacing-1: 0.25rem;  /* 4px */
--spacing-2: 0.5rem;   /* 8px */
--spacing-3: 0.75rem;  /* 12px */
--spacing-4: 1rem;     /* 16px */
--spacing-5: 1.25rem;  /* 20px */
--spacing-6: 1.5rem;   /* 24px */
--spacing-8: 2rem;     /* 32px */
--spacing-10: 2.5rem;  /* 40px */
--spacing-12: 3rem;    /* 48px */
--spacing-16: 4rem;    /* 64px */
--spacing-20: 5rem;    /* 80px */

/* Component-specific spacing */
.document-card-padding: var(--spacing-4);
.filter-panel-padding: var(--spacing-3);
.search-bar-padding: var(--spacing-3) var(--spacing-4);
.selection-basket-padding: var(--spacing-4);
```

### Iconography System

Consistent with iHub's SVG icon approach:

```jsx
// Document Type Icons
const PDFIcon = () => (
  <svg className="w-5 h-5 text-red-600" fill="currentColor" viewBox="0 0 20 20">
    <path d="M4 3a2 2 0 00-2 2v1.5h16V5a2 2 0 00-2-2H4z"/>
    <path d="M18 8.5H2V15a2 2 0 002 2h12a2 2 0 002-2V8.5z"/>
  </svg>
);

const WordIcon = () => (
  <svg className="w-5 h-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
    <path d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm0 2h12v10H4V5z"/>
  </svg>
);

// Action Icons
const SearchIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
);

const FilterIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
  </svg>
);

const GridViewIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
  </svg>
);

const ListViewIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
  </svg>
);
```

## Interaction Design

### Micro-interactions and Animations

Following iHub's subtle animation principles:

```css
/* Hover States */
.document-card {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.document-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 25px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
}

/* Selection Animation */
.document-card.selected {
  animation: selectPulse 0.3s ease-out;
  box-shadow: 0 0 0 3px var(--document-card-selected-border);
}

@keyframes selectPulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.02); }
  100% { transform: scale(1); }
}

/* Filter Application */
.filter-applying {
  opacity: 0.7;
  transition: opacity 0.2s ease-in-out;
}

/* Search Loading */
.search-loading::after {
  content: '';
  width: 2px;
  height: 20px;
  background: var(--primary-blue);
  animation: searchPulse 1.5s ease-in-out infinite;
}

@keyframes searchPulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

/* Drag and Drop */
.drag-over {
  background: var(--success-light);
  border: 2px dashed var(--success-border);
  animation: dragPulse 0.8s ease-in-out infinite;
}

@keyframes dragPulse {
  0%, 100% { opacity: 0.8; }
  50% { opacity: 1; }
}
```

### Gesture Support

Touch-optimized interactions for tablet and mobile:

```css
/* Touch Targets */
.touch-target {
  min-height: 44px;
  min-width: 44px;
}

/* Swipe Gestures for Filters */
.filter-panel.mobile {
  transform: translateX(-100%);
  transition: transform 0.3s ease-out;
}

.filter-panel.mobile.open {
  transform: translateX(0);
}

/* Pull to Refresh */
.document-grid.pull-refresh {
  transform: translateY(60px);
  transition: transform 0.3s ease-out;
}
```

## Responsive Design

### Breakpoint System

Aligned with iHub's responsive strategy:

```css
/* Breakpoints */
@media (min-width: 640px)  { /* sm: Small tablets */ }
@media (min-width: 768px)  { /* md: Large tablets */ }
@media (min-width: 1024px) { /* lg: Small desktops */ }
@media (min-width: 1280px) { /* xl: Large desktops */ }
@media (min-width: 1536px) { /* 2xl: Extra large displays */ }

/* Layout Adaptations */
/* Mobile First (320px+) */
.document-browser {
  padding: var(--spacing-2);
  flex-direction: column;
}

.filter-panel {
  position: fixed;
  top: 0;
  left: 0;
  height: 100vh;
  width: 280px;
  transform: translateX(-100%);
  z-index: 50;
}

.document-grid {
  grid-template-columns: 1fr;
  gap: var(--spacing-4);
}

/* Tablet (768px+) */
@media (min-width: 768px) {
  .document-browser {
    padding: var(--spacing-4);
    flex-direction: row;
  }
  
  .filter-panel {
    position: static;
    transform: translateX(0);
    width: 280px;
    height: auto;
    border-right: 1px solid var(--filter-panel-border);
  }
  
  .document-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--spacing-6);
  }
}

/* Desktop (1024px+) */
@media (min-width: 1024px) {
  .document-browser {
    padding: var(--spacing-6);
  }
  
  .document-grid {
    grid-template-columns: repeat(3, 1fr);
    gap: var(--spacing-8);
  }
  
  .document-card {
    aspect-ratio: 4/3;
  }
}

/* Large Desktop (1280px+) */
@media (min-width: 1280px) {
  .document-grid {
    grid-template-columns: repeat(4, 1fr);
  }
  
  .filter-panel {
    width: 320px;
  }
}
```

### Mobile-Specific Adaptations

```jsx
// Mobile filter panel as bottom sheet
const MobileFilterPanel = ({ isOpen, onClose, children }) => (
  <div className={`
    fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-2xl shadow-2xl
    transform transition-transform duration-300 ease-out
    ${isOpen ? 'translate-y-0' : 'translate-y-full'}
  `}>
    <div className="flex items-center justify-between p-4 border-b">
      <h3 className="text-lg font-semibold">Filters</h3>
      <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100">
        <XIcon className="w-5 h-5" />
      </button>
    </div>
    <div className="max-h-96 overflow-y-auto p-4">
      {children}
    </div>
  </div>
);

// Touch-optimized document cards
const MobileDocumentCard = ({ document, onSelect, isSelected }) => (
  <div className={`
    bg-white rounded-xl border p-4 
    touch-manipulation select-none
    active:scale-95 transition-transform duration-150
    ${isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}
  `}>
    {/* Card content with larger touch targets */}
  </div>
);
```

## Accessibility Implementation

### WCAG 2.1 AA Compliance

#### Color Contrast Requirements
```css
/* All text meets 4.5:1 contrast ratio minimum */
.text-primary { color: #111827; } /* 16.94:1 on white */
.text-secondary { color: #374151; } /* 9.25:1 on white */
.text-muted { color: #6b7280; } /* 4.54:1 on white */

/* Interactive elements meet 3:1 contrast for non-text */
.interactive-border { border-color: #9ca3af; } /* 3.08:1 on white */

/* Focus indicators are highly visible */
.focus-visible {
  outline: 3px solid #3b82f6;
  outline-offset: 2px;
}
```

#### Screen Reader Support
```jsx
// Comprehensive ARIA implementation
const DocumentBrowser = () => (
  <div 
    role="main" 
    aria-label="Document browser"
    className="document-browser"
  >
    {/* Live region for search results */}
    <div 
      aria-live="polite" 
      aria-atomic="false"
      className="sr-only"
      id="search-status"
    >
      {searchResults && `Found ${searchResults.length} documents`}
    </div>
    
    {/* Search with proper labeling */}
    <div role="search">
      <label 
        htmlFor="document-search" 
        className="sr-only"
      >
        Search documents
      </label>
      <input
        id="document-search"
        type="search"
        aria-describedby="search-help"
        aria-autocomplete="list"
        aria-expanded={showSuggestions}
        aria-controls="search-suggestions"
      />
      <div id="search-help" className="sr-only">
        Enter keywords to search documents. Use arrow keys to navigate suggestions.
      </div>
    </div>
    
    {/* Document grid with proper semantics */}
    <div 
      role="grid" 
      aria-label="Document results"
      aria-rowcount={Math.ceil(documents.length / columnsPerRow)}
      aria-colcount={columnsPerRow}
    >
      {documents.map((doc, index) => (
        <div
          key={doc.id}
          role="gridcell"
          aria-rowindex={Math.floor(index / columnsPerRow) + 1}
          aria-colindex={(index % columnsPerRow) + 1}
          aria-selected={selectedDocuments.has(doc.id)}
          aria-describedby={`doc-${doc.id}-description`}
        >
          <DocumentCard document={doc} />
          <div id={`doc-${doc.id}-description`} className="sr-only">
            {`${doc.type} document, ${doc.size}, modified ${doc.lastModified}`}
          </div>
        </div>
      ))}
    </div>
  </div>
);
```

#### Keyboard Navigation Patterns
```jsx
// Comprehensive keyboard support
const useKeyboardNavigation = () => {
  const handleKeyDown = useCallback((event) => {
    const { key, ctrlKey, shiftKey } = event;
    
    switch (key) {
      case 'Enter':
        if (event.target.matches('[role="gridcell"]')) {
          // Toggle document selection
          toggleDocumentSelection(focusedDocumentId);
        }
        break;
        
      case ' ':
        if (event.target.matches('[role="gridcell"]')) {
          event.preventDefault();
          toggleDocumentSelection(focusedDocumentId);
        }
        break;
        
      case 'ArrowDown':
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'ArrowRight':
        event.preventDefault();
        navigateGrid(key);
        break;
        
      case 'Home':
        event.preventDefault();
        focusFirstDocument();
        break;
        
      case 'End':
        event.preventDefault();
        focusLastDocument();
        break;
        
      case 'Escape':
        if (previewOpen) {
          closePreview();
        } else if (hasSelection) {
          clearSelection();
        } else {
          clearSearch();
        }
        break;
        
      case 'a':
        if (ctrlKey) {
          event.preventDefault();
          selectAllDocuments();
        }
        break;
        
      case '/':
        if (!event.target.matches('input')) {
          event.preventDefault();
          focusSearchInput();
        }
        break;
    }
  }, [focusedDocumentId, previewOpen, hasSelection]);
  
  return { handleKeyDown };
};
```

## Error and Loading States

### Loading State Design
```jsx
// Skeleton loading components
const DocumentCardSkeleton = () => (
  <div className="bg-white rounded-xl border p-4 animate-pulse">
    <div className="h-32 bg-gray-200 rounded-lg mb-3"></div>
    <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
    <div className="h-3 bg-gray-200 rounded w-1/2 mb-2"></div>
    <div className="h-3 bg-gray-200 rounded w-1/3"></div>
  </div>
);

// Progressive loading indicator
const SearchLoadingState = ({ progress }) => (
  <div className="flex flex-col items-center justify-center py-12">
    <div className="relative">
      <SearchIcon className="w-8 h-8 text-gray-400 animate-pulse" />
      <div className="absolute -bottom-2 left-1/2 transform -translate-x-1/2">
        <div className="w-8 h-1 bg-gray-200 rounded-full overflow-hidden">
          <div 
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
    <p className="mt-4 text-sm text-gray-600">Searching documents...</p>
  </div>
);
```

### Error State Patterns
```jsx
// Comprehensive error handling
const ErrorStates = {
  NetworkError: ({ onRetry }) => (
    <div className="text-center py-12">
      <WifiOffIcon className="w-12 h-12 text-gray-400 mx-auto mb-4" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">
        Connection Problem
      </h3>
      <p className="text-gray-600 mb-4">
        Unable to connect to the document service. Please check your connection.
      </p>
      <button 
        onClick={onRetry}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
      >
        Try Again
      </button>
    </div>
  ),
  
  SearchError: ({ query, onRetry, onClearSearch }) => (
    <div className="text-center py-12">
      <ExclamationTriangleIcon className="w-12 h-12 text-amber-400 mx-auto mb-4" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">
        Search Failed
      </h3>
      <p className="text-gray-600 mb-4">
        We couldn't search for "{query}". This might be a temporary issue.
      </p>
      <div className="space-x-3">
        <button 
          onClick={onRetry}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Retry Search
        </button>
        <button 
          onClick={onClearSearch}
          className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
        >
          Clear Search
        </button>
      </div>
    </div>
  ),
  
  EmptyResults: ({ query, onClearFilters, hasFilters }) => (
    <div className="text-center py-16">
      <DocumentIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
      <h3 className="text-xl font-medium text-gray-900 mb-2">
        No documents found
      </h3>
      <p className="text-gray-600 mb-6">
        {query 
          ? `No documents match "${query}"${hasFilters ? ' with the current filters' : ''}`
          : 'No documents available'
        }
      </p>
      {hasFilters && (
        <button 
          onClick={onClearFilters}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Clear Filters
        </button>
      )}
      <div className="mt-8 text-left max-w-md mx-auto">
        <h4 className="text-sm font-medium text-gray-900 mb-2">Try:</h4>
        <ul className="text-sm text-gray-600 space-y-1">
          <li>• Using different search terms</li>
          <li>• Removing some filters</li>
          <li>• Checking your search profile permissions</li>
        </ul>
      </div>
    </div>
  )
};
```

### Empty State Design
```jsx
const EmptyDocumentBrowser = ({ onGetStarted }) => (
  <div className="flex flex-col items-center justify-center min-h-96 text-center">
    <div className="bg-gradient-to-br from-blue-50 to-indigo-100 rounded-full p-6 mb-6">
      <DocumentSearchIcon className="w-12 h-12 text-blue-600" />
    </div>
    <h2 className="text-2xl font-bold text-gray-900 mb-2">
      Discover Your Documents
    </h2>
    <p className="text-gray-600 mb-8 max-w-md">
      Search through your document library to find exactly what you need for your AI conversations.
    </p>
    <div className="space-y-4">
      <button 
        onClick={onGetStarted}
        className="px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 transition-all duration-200"
      >
        Start Searching
      </button>
      <div className="flex items-center space-x-6 text-sm text-gray-500">
        <span className="flex items-center">
          <SearchIcon className="w-4 h-4 mr-1" />
          Smart Search
        </span>
        <span className="flex items-center">
          <FilterIcon className="w-4 h-4 mr-1" />
          Advanced Filters
        </span>
        <span className="flex items-center">
          <SelectIcon className="w-4 h-4 mr-1" />
          Bulk Selection
        </span>
      </div>
    </div>
  </div>
);
```

## Integration Points with iHub

### Theme Integration
```css
/* Dynamic theme support using CSS custom properties */
:root {
  --ifinder-primary: var(--ihub-primary, rgb(0, 53, 87));
  --ifinder-secondary: var(--ihub-secondary, #6b7280);
  --ifinder-accent: var(--ihub-accent, #3b82f6);
  --ifinder-background: var(--ihub-background, #ffffff);
  --ifinder-surface: var(--ihub-surface, #f8fafc);
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  :root {
    --ifinder-background: #111827;
    --ifinder-surface: #1f2937;
    --document-card-bg: #374151;
    --document-card-border: #4b5563;
  }
}
```

### Source System Integration
```jsx
// Integration with iHub's source selection system
const DocumentSelectionHandler = {
  // Convert selected documents to iHub source format
  formatForSources: (selectedDocuments) => {
    return selectedDocuments.map(doc => ({
      id: doc.id,
      type: 'ifinder-document',
      title: doc.title,
      content: doc.snippet || doc.title,
      metadata: {
        author: doc.author,
        documentType: doc.documentType,
        lastModified: doc.lastModified,
        source: 'iFinder Document Browser'
      },
      url: doc.url,
      searchProfile: doc.searchProfile
    }));
  },
  
  // Add sources to current AI chat session
  addToSources: async (documents, chatId) => {
    const sources = DocumentSelectionHandler.formatForSources(documents);
    
    try {
      const response = await fetch('/api/chat/sources', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': getAuthHeader()
        },
        body: JSON.stringify({
          chatId,
          sources,
          action: 'add'
        })
      });
      
      if (response.ok) {
        showNotification('Documents added to sources', 'success');
        return true;
      }
    } catch (error) {
      showNotification('Failed to add documents to sources', 'error');
      return false;
    }
  }
};
```

## Implementation Notes

### Performance Considerations

1. **Virtual Scrolling**: Implement for document grids with 100+ items
2. **Image Lazy Loading**: Progressive loading of document thumbnails
3. **Search Debouncing**: 300ms delay for auto-complete, 500ms for full search
4. **Cache Strategy**: Implement service worker for offline document metadata
5. **Bundle Optimization**: Code splitting for filter components

### Accessibility Testing Checklist

- [ ] All interactive elements keyboard accessible
- [ ] Screen reader announcements for dynamic content
- [ ] Color contrast ratios meet WCAG AA standards
- [ ] Focus indicators clearly visible
- [ ] Form labels properly associated
- [ ] Error messages announce to screen readers
- [ ] Loading states accessible to assistive technology

### Browser Support

- **Minimum Support**: Chrome 88+, Firefox 85+, Safari 14+, Edge 88+
- **Progressive Enhancement**: Advanced features gracefully degrade
- **Polyfills**: IntersectionObserver, ResizeObserver for older browsers

This comprehensive UI/UX brief provides the foundation for implementing a world-class document browser experience that seamlessly integrates with iHub's existing design system while introducing specialized patterns for document discovery and selection workflows.

The design emphasizes accessibility, performance, and user experience while maintaining consistency with iHub's established visual identity and interaction patterns. The component architecture supports both novice and power users, with progressive disclosure of advanced features and comprehensive keyboard navigation support.