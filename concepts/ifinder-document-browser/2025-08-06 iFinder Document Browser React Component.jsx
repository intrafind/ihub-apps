function UserComponent(props) {
  const { React, useState, useEffect, useCallback, useMemo, useRef, t, navigate, user } = props;

  // Core state management
  const [searchState, setSearchState] = useState({
    query: '',
    searchProfile: 'default',
    results: [],
    totalCount: 0,
    loading: false,
    error: null,
    facets: null,
    queryTime: 0
  });

  const [filterState, setFilterState] = useState({
    documentTypes: new Set(),
    dateRange: null,
    authors: new Set(),
    sources: new Set(),
    sizeRange: null,
    activeFilters: 0
  });

  const [uiState, setUIState] = useState({
    viewMode: 'grid', // 'grid' | 'list'
    selectedDocuments: new Set(),
    previewDocument: null,
    showPreviewModal: false,
    sortBy: 'relevance',
    sortDirection: 'desc',
    page: 1,
    pageSize: 20,
    showFilters: true
  });

  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Refs for functionality
  const searchInputRef = useRef(null);
  const abortControllerRef = useRef(null);
  const debounceTimerRef = useRef(null);

  // Search profiles configuration
  const searchProfiles = useMemo(() => [
    { id: 'default', name: 'All Documents', description: 'Search across all document types' },
    { id: 'reports', name: 'Reports', description: 'Business reports and analytics' },
    { id: 'policies', name: 'Policies', description: 'Company policies and procedures' },
    { id: 'technical', name: 'Technical', description: 'Technical documentation' }
  ], []);

  // Document type options with icons
  const documentTypes = useMemo(() => [
    { id: 'pdf', name: 'PDF Documents', icon: '📄', color: 'text-red-600' },
    { id: 'word', name: 'Word Documents', icon: '📝', color: 'text-blue-600' },
    { id: 'excel', name: 'Excel Spreadsheets', icon: '📊', color: 'text-green-600' },
    { id: 'powerpoint', name: 'PowerPoint', icon: '📺', color: 'text-orange-600' },
    { id: 'text', name: 'Text Files', icon: '📋', color: 'text-gray-600' },
    { id: 'image', name: 'Images', icon: '🖼️', color: 'text-purple-600' }
  ], []);

  // API helper functions
  const searchDocuments = useCallback(async (query, filters = {}, pagination = {}) => {
    try {
      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const params = new URLSearchParams();
      if (query) params.append('query', query);
      params.append('searchProfile', searchState.searchProfile);
      params.append('page', pagination.page || 1);
      params.append('limit', pagination.limit || 20);
      params.append('includePreview', 'true');
      params.append('includeFacets', 'true');

      // Add filters
      if (filters.documentTypes && filters.documentTypes.size > 0) {
        Array.from(filters.documentTypes).forEach(type => 
          params.append('documentTypes[]', type)
        );
      }

      if (filters.dateRange) {
        params.append('dateField', filters.dateRange.field || 'modified');
        if (filters.dateRange.start) {
          params.append('dateStart', filters.dateRange.start.toISOString());
        }
        if (filters.dateRange.end) {
          params.append('dateEnd', filters.dateRange.end.toISOString());
        }
      }

      if (filters.authors && filters.authors.size > 0) {
        Array.from(filters.authors).forEach(author => 
          params.append('authors[]', author)
        );
      }

      if (uiState.sortBy !== 'relevance') {
        params.append('sortBy', uiState.sortBy);
        params.append('sortDirection', uiState.sortDirection);
      }

      const response = await fetch(`/api/ifinder/browser/search?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('authToken')}` // Use existing auth
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        results: data.results || [],
        totalCount: data.totalCount || 0,
        facets: data.facets || null,
        queryTime: data.queryTime || 0
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        return null; // Request was cancelled
      }
      throw error;
    }
  }, [searchState.searchProfile, uiState.sortBy, uiState.sortDirection]);

  const getSearchSuggestions = useCallback(async (query) => {
    if (query.length < 2) return [];
    
    try {
      const response = await fetch('/api/ifinder/browser/search-suggestions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('authToken')}`
        },
        body: JSON.stringify({
          query,
          searchProfile: searchState.searchProfile,
          limit: 5
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.suggestions || [];
      }
    } catch (error) {
      console.warn('Failed to fetch suggestions:', error);
    }
    return [];
  }, [searchState.searchProfile]);

  // Debounced search function
  const performSearch = useCallback((query, immediate = false) => {
    const delay = immediate ? 0 : 300;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(async () => {
      if (!query.trim() && !hasActiveFilters()) return;

      setSearchState(prev => ({ ...prev, loading: true, error: null }));

      try {
        const result = await searchDocuments(query, filterState, { 
          page: uiState.page, 
          limit: uiState.pageSize 
        });

        if (result) { // Not cancelled
          setSearchState(prev => ({
            ...prev,
            results: result.results,
            totalCount: result.totalCount,
            facets: result.facets,
            queryTime: result.queryTime,
            loading: false
          }));
        }
      } catch (error) {
        setSearchState(prev => ({
          ...prev,
          loading: false,
          error: error.message || 'Search failed'
        }));
      }
    }, delay);
  }, [searchDocuments, filterState, uiState.page, uiState.pageSize]);

  // Helper function to check for active filters
  const hasActiveFilters = useCallback(() => {
    return filterState.documentTypes.size > 0 ||
           filterState.authors.size > 0 ||
           filterState.sources.size > 0 ||
           filterState.dateRange !== null ||
           filterState.sizeRange !== null;
  }, [filterState]);

  // Event handlers
  const handleSearchChange = useCallback((value) => {
    setSearchState(prev => ({ ...prev, query: value }));
    performSearch(value);
    
    // Handle suggestions
    if (value.length >= 2) {
      getSearchSuggestions(value).then(setSuggestions);
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
      setSuggestions([]);
    }
  }, [performSearch, getSearchSuggestions]);

  const handleSearchSubmit = useCallback((e) => {
    e.preventDefault();
    performSearch(searchState.query, true);
    setShowSuggestions(false);
  }, [performSearch, searchState.query]);

  const handleFilterChange = useCallback((filterType, value) => {
    setFilterState(prev => {
      const newState = { ...prev };
      
      switch (filterType) {
        case 'documentType':
          newState.documentTypes = new Set(prev.documentTypes);
          if (newState.documentTypes.has(value)) {
            newState.documentTypes.delete(value);
          } else {
            newState.documentTypes.add(value);
          }
          break;
          
        case 'author':
          newState.authors = new Set(prev.authors);
          if (newState.authors.has(value)) {
            newState.authors.delete(value);
          } else {
            newState.authors.add(value);
          }
          break;
          
        case 'dateRange':
          newState.dateRange = value;
          break;
          
        case 'clear':
          return {
            documentTypes: new Set(),
            dateRange: null,
            authors: new Set(),
            sources: new Set(),
            sizeRange: null,
            activeFilters: 0
          };
      }
      
      // Count active filters
      newState.activeFilters = 
        newState.documentTypes.size +
        newState.authors.size +
        newState.sources.size +
        (newState.dateRange ? 1 : 0) +
        (newState.sizeRange ? 1 : 0);
      
      return newState;
    });
    
    // Trigger search with new filters
    performSearch(searchState.query, true);
  }, [performSearch, searchState.query]);

  const handleDocumentSelect = useCallback((documentId) => {
    setUIState(prev => {
      const newSelected = new Set(prev.selectedDocuments);
      if (newSelected.has(documentId)) {
        newSelected.delete(documentId);
      } else {
        newSelected.add(documentId);
      }
      return { ...prev, selectedDocuments: newSelected };
    });
  }, []);

  const handleDocumentPreview = useCallback((document) => {
    setUIState(prev => ({
      ...prev,
      previewDocument: document,
      showPreviewModal: true
    }));
  }, []);

  const handleUseSelected = useCallback(() => {
    const selectedDocs = searchState.results.filter(doc => 
      uiState.selectedDocuments.has(doc.id)
    );
    
    // Integration with iHub source system would go here
    console.log('Adding selected documents to iHub sources:', selectedDocs);
    
    // Show success notification
    alert(`Added ${selectedDocs.length} document(s) to your AI conversation sources.`);
    
    // Clear selection
    setUIState(prev => ({ ...prev, selectedDocuments: new Set() }));
  }, [searchState.results, uiState.selectedDocuments]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (uiState.showPreviewModal) {
          setUIState(prev => ({ ...prev, showPreviewModal: false }));
        } else if (showSuggestions) {
          setShowSuggestions(false);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [uiState.showPreviewModal, showSuggestions]);

  // Format file size helper
  const formatFileSize = useCallback((bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }, []);

  // Format date helper
  const formatDate = useCallback((dateString) => {
    if (!dateString) return 'Unknown';
    return new Date(dateString).toLocaleDateString();
  }, []);

  // Document Card Component
  const DocumentCard = React.memo(({ document, isSelected, onSelect, onPreview }) => {
    const typeInfo = documentTypes.find(t => 
      document.mimeType?.includes(t.id) || 
      document.documentType?.toLowerCase().includes(t.id)
    ) || documentTypes[0];

    return (
      <div 
        className={`bg-white rounded-lg shadow-md hover:shadow-lg transition-all duration-200 cursor-pointer border-2 ${
          isSelected ? 'border-blue-500 bg-blue-50' : 'border-transparent hover:border-gray-200'
        }`}
        onClick={() => onSelect(document.id)}
        onDoubleClick={() => onPreview(document)}
      >
        <div className="p-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center space-x-2 flex-1 min-w-0">
              <span className={`text-xl ${typeInfo.color}`} title={typeInfo.name}>
                {typeInfo.icon}
              </span>
              <h3 className="text-sm font-medium text-gray-900 truncate">
                {document.title || document.filename || 'Untitled Document'}
              </h3>
            </div>
            {isSelected && (
              <div className="text-blue-500 ml-2">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </div>
            )}
          </div>
          
          <div className="space-y-2">
            {document.author && (
              <p className="text-xs text-gray-600">
                <span className="font-medium">Author:</span> {document.author}
              </p>
            )}
            
            {document.lastModified && (
              <p className="text-xs text-gray-600">
                <span className="font-medium">Modified:</span> {formatDate(document.lastModified)}
              </p>
            )}
            
            {document.size && (
              <p className="text-xs text-gray-600">
                <span className="font-medium">Size:</span> {formatFileSize(document.size)}
              </p>
            )}
            
            {document.snippet && (
              <p className="text-xs text-gray-700 line-clamp-3">
                {document.snippet}
              </p>
            )}
          </div>
          
          <div className="mt-3 flex justify-between items-center">
            <span className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded">
              {document.documentType || 'Unknown'}
            </span>
            {document.score && (
              <span className="text-xs text-gray-500">
                {Math.round(document.score * 100)}% match
              </span>
            )}
          </div>
        </div>
      </div>
    );
  });

  // Filter Panel Component
  const FilterPanel = React.memo(() => (
    <div className="bg-white rounded-lg shadow-sm border p-4 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-900">Filters</h3>
        {filterState.activeFilters > 0 && (
          <button
            onClick={() => handleFilterChange('clear')}
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            Clear all ({filterState.activeFilters})
          </button>
        )}
      </div>

      {/* Document Type Filter */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-2">Document Type</h4>
        <div className="space-y-1">
          {documentTypes.map(type => (
            <label key={type.id} className="flex items-center">
              <input
                type="checkbox"
                checked={filterState.documentTypes.has(type.id)}
                onChange={() => handleFilterChange('documentType', type.id)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm text-gray-700 flex items-center">
                <span className={`mr-1 ${type.color}`}>{type.icon}</span>
                {type.name}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Date Range Filter */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-2">Date Range</h4>
        <div className="space-y-2">
          <select
            className="w-full text-xs border border-gray-300 rounded px-2 py-1"
            onChange={(e) => {
              if (e.target.value === '') {
                handleFilterChange('dateRange', null);
                return;
              }
              
              const days = parseInt(e.target.value);
              const end = new Date();
              const start = new Date();
              start.setDate(start.getDate() - days);
              
              handleFilterChange('dateRange', {
                field: 'modified',
                start,
                end
              });
            }}
          >
            <option value="">Any time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 3 months</option>
            <option value="365">Last year</option>
          </select>
        </div>
      </div>

      {/* Authors Filter */}
      {searchState.facets?.authors && searchState.facets.authors.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">Authors</h4>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {searchState.facets.authors.slice(0, 10).map(author => (
              <label key={author.value} className="flex items-center">
                <input
                  type="checkbox"
                  checked={filterState.authors.has(author.value)}
                  onChange={() => handleFilterChange('author', author.value)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700 flex-1 truncate">
                  {author.displayName || author.value}
                </span>
                <span className="text-xs text-gray-500">({author.count})</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  ));

  // Preview Modal Component
  const PreviewModal = React.memo(() => {
    if (!uiState.showPreviewModal || !uiState.previewDocument) return null;

    const doc = uiState.previewDocument;

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg max-w-4xl max-h-screen overflow-hidden flex flex-col">
          <div className="flex items-center justify-between p-6 border-b">
            <h2 className="text-xl font-semibold text-gray-900 truncate">
              {doc.title || doc.filename || 'Document Preview'}
            </h2>
            <button
              onClick={() => setUIState(prev => ({ ...prev, showPreviewModal: false }))}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          <div className="p-6 overflow-y-auto flex-1">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="font-medium text-gray-900 mb-3">Document Details</h3>
                <div className="space-y-2 text-sm">
                  {doc.author && <p><span className="font-medium">Author:</span> {doc.author}</p>}
                  {doc.documentType && <p><span className="font-medium">Type:</span> {doc.documentType}</p>}
                  {doc.size && <p><span className="font-medium">Size:</span> {formatFileSize(doc.size)}</p>}
                  {doc.createdDate && <p><span className="font-medium">Created:</span> {formatDate(doc.createdDate)}</p>}
                  {doc.lastModified && <p><span className="font-medium">Modified:</span> {formatDate(doc.lastModified)}</p>}
                  {doc.language && <p><span className="font-medium">Language:</span> {doc.language}</p>}
                </div>
              </div>
              
              <div>
                <h3 className="font-medium text-gray-900 mb-3">Content Preview</h3>
                {doc.snippet ? (
                  <div className="bg-gray-50 p-3 rounded text-sm text-gray-700 max-h-48 overflow-y-auto">
                    {doc.snippet}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 italic">No preview available</p>
                )}
              </div>
            </div>
            
            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={() => {
                  handleDocumentSelect(doc.id);
                  setUIState(prev => ({ ...prev, showPreviewModal: false }));
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              >
                {uiState.selectedDocuments.has(doc.id) ? 'Deselect' : 'Select'} Document
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="py-4">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-semibold text-gray-900">iFinder Document Browser</h1>
                <p className="text-sm text-gray-600">Search and browse documents from iFinder</p>
              </div>
              
              {/* Search Profile Selector */}
              <div className="flex items-center space-x-4">
                <select
                  value={searchState.searchProfile}
                  onChange={(e) => setSearchState(prev => ({ ...prev, searchProfile: e.target.value }))}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {searchProfiles.map(profile => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="py-4">
            <form onSubmit={handleSearchSubmit} className="relative">
              <div className="relative">
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search documents..."
                  value={searchState.query}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="w-full px-4 py-3 pl-10 pr-4 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-lg"
                />
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                
                {searchState.loading && (
                  <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                  </div>
                )}
              </div>

              {/* Search Suggestions */}
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute z-10 w-full bg-white mt-1 border border-gray-200 rounded-md shadow-lg">
                  {suggestions.map((suggestion, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => {
                        setSearchState(prev => ({ ...prev, query: suggestion.text }));
                        performSearch(suggestion.text, true);
                        setShowSuggestions(false);
                      }}
                      className="w-full text-left px-4 py-2 hover:bg-gray-50 text-sm"
                    >
                      {suggestion.text}
                      {suggestion.documentCount && (
                        <span className="text-gray-500 ml-2">({suggestion.documentCount} docs)</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </form>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Sidebar with Filters */}
          <div className="w-full lg:w-1/4">
            <FilterPanel />
          </div>

          {/* Main Content */}
          <div className="w-full lg:w-3/4">
            {/* Results Header */}
            <div className="bg-white rounded-lg shadow-sm border p-4 mb-6">
              <div className="flex items-center justify-between">
                <div>
                  {searchState.totalCount > 0 ? (
                    <p className="text-sm text-gray-600">
                      Found {searchState.totalCount.toLocaleString()} documents
                      {searchState.queryTime > 0 && (
                        <span className="text-gray-400"> in {searchState.queryTime}ms</span>
                      )}
                    </p>
                  ) : searchState.query || hasActiveFilters() ? (
                    <p className="text-sm text-gray-600">No documents found</p>
                  ) : (
                    <p className="text-sm text-gray-600">Enter search terms or apply filters to find documents</p>
                  )}
                </div>

                <div className="flex items-center space-x-4">
                  {/* View Mode Toggle */}
                  <div className="flex items-center border border-gray-300 rounded-md">
                    <button
                      onClick={() => setUIState(prev => ({ ...prev, viewMode: 'grid' }))}
                      className={`px-3 py-1 text-xs ${
                        uiState.viewMode === 'grid' 
                          ? 'bg-blue-100 text-blue-700' 
                          : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      Grid
                    </button>
                    <button
                      onClick={() => setUIState(prev => ({ ...prev, viewMode: 'list' }))}
                      className={`px-3 py-1 text-xs ${
                        uiState.viewMode === 'list' 
                          ? 'bg-blue-100 text-blue-700' 
                          : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      List
                    </button>
                  </div>

                  {/* Sort Options */}
                  <select
                    value={`${uiState.sortBy}-${uiState.sortDirection}`}
                    onChange={(e) => {
                      const [sortBy, sortDirection] = e.target.value.split('-');
                      setUIState(prev => ({ ...prev, sortBy, sortDirection }));
                      performSearch(searchState.query, true);
                    }}
                    className="text-xs border border-gray-300 rounded px-2 py-1"
                  >
                    <option value="relevance-desc">Most Relevant</option>
                    <option value="title-asc">Title A-Z</option>
                    <option value="title-desc">Title Z-A</option>
                    <option value="modified-desc">Recently Modified</option>
                    <option value="modified-asc">Oldest First</option>
                    <option value="size-desc">Largest First</option>
                    <option value="size-asc">Smallest First</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Selection Toolbar */}
            {uiState.selectedDocuments.size > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    <span className="text-sm font-medium text-blue-900">
                      {uiState.selectedDocuments.size} document(s) selected
                    </span>
                    <button
                      onClick={() => setUIState(prev => ({ ...prev, selectedDocuments: new Set() }))}
                      className="text-sm text-blue-700 hover:text-blue-900"
                    >
                      Clear selection
                    </button>
                  </div>
                  <div className="flex items-center space-x-3">
                    <button
                      onClick={handleUseSelected}
                      className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
                    >
                      Use Selected Documents
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Error State */}
            {searchState.error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                <div className="flex items-center">
                  <svg className="w-5 h-5 text-red-400 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <p className="text-red-800 text-sm">{searchState.error}</p>
                </div>
              </div>
            )}

            {/* Loading State */}
            {searchState.loading && (
              <div className="flex justify-center items-center py-12">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                  <p className="text-gray-600">Searching documents...</p>
                </div>
              </div>
            )}

            {/* Results Grid/List */}
            {!searchState.loading && searchState.results.length > 0 && (
              <div className={
                uiState.viewMode === 'grid' 
                  ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'
                  : 'space-y-3'
              }>
                {searchState.results.map(document => (
                  <DocumentCard
                    key={document.id}
                    document={document}
                    isSelected={uiState.selectedDocuments.has(document.id)}
                    onSelect={handleDocumentSelect}
                    onPreview={handleDocumentPreview}
                  />
                ))}
              </div>
            )}

            {/* Empty State */}
            {!searchState.loading && searchState.results.length === 0 && !searchState.error && (searchState.query || hasActiveFilters()) && (
              <div className="text-center py-12">
                <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 48 48">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <h3 className="mt-2 text-sm font-medium text-gray-900">No documents found</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Try adjusting your search terms or filters to find what you're looking for.
                </p>
              </div>
            )}

            {/* Welcome State */}
            {!searchState.loading && searchState.results.length === 0 && !searchState.error && !searchState.query && !hasActiveFilters() && (
              <div className="text-center py-12">
                <div className="text-6xl mb-4">📚</div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">Welcome to iFinder Document Browser</h3>
                <p className="text-gray-600 mb-6 max-w-md mx-auto">
                  Search across your organization's documents and easily add them to your AI conversations as sources.
                </p>
                <div className="space-y-2 text-sm text-gray-500">
                  <p>• Search by keywords, document type, author, or date</p>
                  <p>• Preview documents before selecting them</p>
                  <p>• Add multiple documents as sources at once</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Preview Modal */}
      <PreviewModal />
    </div>
  );
}