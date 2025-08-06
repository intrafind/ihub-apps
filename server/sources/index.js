/**
 * Source Handlers Module
 *
 * Exports all source-related components for loading content from various sources.
 * This module provides a unified interface for handling different source types
 * including filesystem, URLs, iFinder document management system, and pages.
 */

import SourceHandler from './SourceHandler.js';
import FileSystemHandler from './FileSystemHandler.js';
import URLHandler from './URLHandler.js';
import IFinderHandler from './IFinderHandler.js';
import PageHandler from './PageHandler.js';
import SourceManager from './SourceManager.js';

// Singleton instance of SourceManager
let singletonSourceManager = null;

// Factory function to create source manager with default configuration
export const createSourceManager = (config = {}) => {
  if (!singletonSourceManager) {
    singletonSourceManager = new SourceManager(config);
  }
  return singletonSourceManager;
};

// Helper to validate source configurations
export const validateSourceConfig = sourceConfig => {
  const manager = createSourceManager();
  return manager.validateSourceConfig(sourceConfig);
};

// Helper to get available handler types
export const getAvailableHandlerTypes = () => {
  return ['filesystem', 'url', 'ifinder', 'page'];
};

// Export all components
export { SourceHandler, FileSystemHandler, URLHandler, IFinderHandler, PageHandler, SourceManager };
