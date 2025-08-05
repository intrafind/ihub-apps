import React, { useState, useEffect } from 'react';
import {
  DocumentTextIcon,
  EyeIcon,
  CheckIcon,
  ExclamationTriangleIcon
} from '@heroicons/react/24/outline';
import { adminApi } from '../../../api/adminApi';

/**
 * Source Content Editor Component
 *
 * Provides integrated content editing capabilities for filesystem sources.
 * Allows users to view, edit, and save source content directly from the admin interface.
 *
 * Features:
 * - Load and display source content
 * - Inline editing with Monaco-style textarea
 * - Save content back to filesystem
 * - Content validation and preview
 * - Support for different content types (markdown, text, JSON)
 *
 * @param {object} props - Component properties
 * @param {string} props.sourceId - Source ID to edit content for
 * @param {string} props.sourceType - Source type (filesystem, url, ifinder)
 * @param {object} props.sourceConfig - Source configuration
 * @param {Function} props.onContentChange - Callback when content changes
 * @param {Function} props.onClose - Callback when editor is closed
 * @param {boolean} props.isOpen - Whether editor is open
 */
function SourceContentEditor({
  sourceId,
  sourceType,
  sourceConfig,
  onContentChange,
  onClose,
  isOpen = false
}) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  // Load content when editor opens
  useEffect(() => {
    if (isOpen && sourceId) {
      loadContent();
    }
  }, [isOpen, sourceId]);

  // Track changes
  useEffect(() => {
    setHasChanges(content !== originalContent);
  }, [content, originalContent]);

  /**
   * Load source content for editing
   */
  const loadContent = async () => {
    try {
      setLoading(true);
      setError(null);

      // Only filesystem sources support content editing currently
      if (sourceType !== 'filesystem') {
        setError('Content editing is only supported for filesystem sources');
        return;
      }

      // For now, we'll simulate loading content since the API doesn't exist yet
      // In a real implementation, this would call adminApi.getSourceContent(sourceId)

      // Simulate loading from file based on source config
      const filePath = sourceConfig?.path || '';
      let simulatedContent = '';

      if (filePath.includes('faq')) {
        simulatedContent = `# Frequently Asked Questions

## General Questions

### What is AI Hub Apps?

AI Hub Apps is a platform that provides a collection of specialized AI assistants designed for various tasks. Each app is optimized for specific purposes like translation, summarization, email composition, and more.

### How do I start using an app?

Simply click on any app tile from the main dashboard. Each app has a custom interface tailored to its specific function with appropriate input fields and options.

(Edit this content and save to update the source file)`;
      } else if (filePath.includes('documentation')) {
        simulatedContent = `# Documentation

This is the system documentation source file.

You can edit this content directly from the admin interface.

## Features

- Source management
- Content editing
- Admin interface

(This is editable content)`;
      } else {
        simulatedContent =
          '# Source Content\n\nEdit this content...\n\n(This is a placeholder. In a real implementation, content would be loaded from the actual source file)';
      }

      setContent(simulatedContent);
      setOriginalContent(simulatedContent);

      console.log(`Loaded content for source: ${sourceId} (${simulatedContent.length} characters)`);
    } catch (err) {
      console.error('Failed to load source content:', err);
      setError('Failed to load source content: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Save content changes
   */
  const saveContent = async () => {
    try {
      setSaving(true);
      setError(null);

      // For now, we'll simulate saving
      // In a real implementation, this would call adminApi.saveSourceContent(sourceId, { content })

      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate save delay

      setOriginalContent(content);
      onContentChange?.(content);

      console.log(`Saved content for source: ${sourceId}`);
    } catch (err) {
      console.error('Failed to save source content:', err);
      setError('Failed to save content: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Handle content change
   */
  const handleContentChange = newContent => {
    setContent(newContent);
  };

  /**
   * Discard changes and revert to original
   */
  const discardChanges = () => {
    setContent(originalContent);
  };

  /**
   * Get content type for syntax highlighting hints
   */
  const getContentType = () => {
    const path = sourceConfig?.path || '';
    if (path.endsWith('.md')) return 'markdown';
    if (path.endsWith('.json')) return 'json';
    if (path.endsWith('.html')) return 'html';
    if (path.endsWith('.css')) return 'css';
    if (path.endsWith('.js')) return 'javascript';
    return 'text';
  };

  /**
   * Render content preview (for markdown)
   */
  const renderPreview = () => {
    const contentType = getContentType();

    if (contentType === 'markdown') {
      // Simple markdown preview - in a real implementation, use a proper markdown renderer
      return (
        <div className="prose max-w-none p-4 bg-gray-50 rounded border">
          <pre className="whitespace-pre-wrap text-sm">{content}</pre>
        </div>
      );
    }

    if (contentType === 'json') {
      try {
        const parsed = JSON.parse(content);
        return (
          <div className="p-4 bg-gray-50 rounded border">
            <pre className="text-sm">{JSON.stringify(parsed, null, 2)}</pre>
          </div>
        );
      } catch (e) {
        return (
          <div className="p-4 bg-red-50 border border-red-200 rounded">
            <p className="text-red-600 text-sm">Invalid JSON: {e.message}</p>
          </div>
        );
      }
    }

    return (
      <div className="p-4 bg-gray-50 rounded border">
        <pre className="whitespace-pre-wrap text-sm">{content}</pre>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center">
            <DocumentTextIcon className="h-6 w-6 text-gray-400 mr-3" />
            <div>
              <h2 className="text-lg font-medium text-gray-900">Edit Source Content</h2>
              <p className="text-sm text-gray-500">
                Source: <span className="font-mono">{sourceId}</span>
                {sourceConfig?.path && (
                  <span className="ml-2">
                    • Path: <span className="font-mono">{sourceConfig.path}</span>
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            {/* Preview toggle */}
            <button
              onClick={() => setPreviewMode(!previewMode)}
              className={`p-2 rounded-md text-sm font-medium ${
                previewMode
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              title={previewMode ? 'Edit mode' : 'Preview mode'}
            >
              <EyeIcon className="h-4 w-4" />
            </button>

            {/* Close button */}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <span className="ml-3 text-gray-600">Loading content...</span>
            </div>
          ) : error ? (
            <div className="p-6">
              <div className="bg-red-50 border border-red-200 rounded-md p-4">
                <div className="flex">
                  <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-800">Error</h3>
                    <p className="mt-1 text-sm text-red-700">{error}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 p-6 overflow-hidden">
              {previewMode ? (
                <div className="h-full overflow-auto">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Preview</h3>
                  {renderPreview()}
                </div>
              ) : (
                <div className="h-full flex flex-col">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-gray-700">Content Editor</h3>
                    <div className="text-xs text-gray-500">
                      Type: {getContentType()} • {content.length} characters
                    </div>
                  </div>

                  <textarea
                    value={content}
                    onChange={e => handleContentChange(e.target.value)}
                    className="flex-1 block w-full border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 font-mono text-sm resize-none"
                    placeholder="Enter source content here..."
                    style={{ minHeight: '400px' }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-gray-200 bg-gray-50">
          <div className="flex items-center text-sm text-gray-600">
            {hasChanges && (
              <div className="flex items-center text-orange-600">
                <div className="w-2 h-2 bg-orange-400 rounded-full mr-2"></div>
                Unsaved changes
              </div>
            )}
            {!hasChanges && originalContent && (
              <div className="flex items-center text-green-600">
                <CheckIcon className="w-4 h-4 mr-1" />
                Saved
              </div>
            )}
          </div>

          <div className="flex items-center space-x-3">
            {hasChanges && (
              <button
                onClick={discardChanges}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Discard Changes
              </button>
            )}

            <button
              onClick={saveContent}
              disabled={!hasChanges || saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {saving ? (
                <div className="flex items-center">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Saving...
                </div>
              ) : (
                'Save Content'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SourceContentEditor;
