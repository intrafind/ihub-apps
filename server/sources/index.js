/**
 * Source Handlers Module
 * 
 * Exports all source-related components for loading content from various sources.
 * This module provides a unified interface for handling different source types
 * including filesystem, URLs, and iFinder document management system.
 */

import SourceHandler from './SourceHandler.js';
import FileSystemHandler from './FileSystemHandler.js';
import URLHandler from './URLHandler.js';
import IFinderHandler from './IFinderHandler.js';
import SourceManager from './SourceManager.js';

// Factory function to create source manager with default configuration
export const createSourceManager = (config = {}) => {
  return new SourceManager(config);
};

// Helper to validate source configurations
export const validateSourceConfig = (sourceConfig) => {
  const manager = new SourceManager();
  return manager.validateSourceConfig(sourceConfig);
};

// Helper to get available handler types
export const getAvailableHandlerTypes = () => {
  return ['filesystem', 'url', 'ifinder'];
};

// Export all components
export {
  SourceHandler,
  FileSystemHandler,
  URLHandler,
  IFinderHandler,
  SourceManager
};