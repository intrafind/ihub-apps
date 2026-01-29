import { useRef, useState } from 'react';
import PropTypes from 'prop-types';
import useMCPAppBridge from '../hooks/useMCPAppBridge';
import {
  buildResourceUrl,
  generateSandboxAttributes,
  extractUIMetadata
} from '../utils/mcpAppSecurity';
import Icon from '../../../shared/components/Icon';

/**
 * MCPAppRenderer Component
 * Renders MCP Apps in sandboxed iframes with bidirectional communication
 */
export default function MCPAppRenderer({ toolResult, chatId, basePath = '' }) {
  const iframeRef = useRef(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const uiMetadata = extractUIMetadata(toolResult);

  // Setup message bridge
  const { isInitialized } = useMCPAppBridge({
    iframeRef,
    toolResult,
    chatId,
    onError: setError
  });

  if (!uiMetadata) {
    return null;
  }

  const resourceUrl = buildResourceUrl(uiMetadata.resourceUri, basePath);
  const sandboxAttrs = generateSandboxAttributes(uiMetadata.permissions);

  // Get display hints for sizing
  const displayHints = uiMetadata.displayHints || {};
  const width = displayHints.width || 'normal';
  const height = displayHints.height || 'normal';

  // Map width/height hints to CSS classes
  const widthClasses = {
    compact: 'max-w-md',
    normal: 'max-w-2xl',
    wide: 'max-w-4xl',
    full: 'w-full'
  };

  const heightClasses = {
    compact: 'h-48',
    normal: 'h-96',
    tall: 'h-[600px]',
    auto: 'h-auto'
  };

  const widthClass = widthClasses[width] || widthClasses.normal;
  const heightClass = heightClasses[height] || heightClasses.normal;

  const handleIframeLoad = () => {
    setIsLoading(false);
  };

  const handleIframeError = () => {
    setError(new Error('Failed to load MCP App'));
    setIsLoading(false);
  };

  return (
    <div className="my-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2 text-sm text-gray-600 dark:text-gray-400">
        <Icon name="CubeIcon" className="w-4 h-4" />
        <span>Interactive App</span>
        {isInitialized && (
          <span className="text-green-600 dark:text-green-400">● Connected</span>
        )}
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-800 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-2 text-red-800 dark:text-red-200">
            <Icon name="ExclamationTriangleIcon" className="w-5 h-5" />
            <span className="font-medium">Error loading app</span>
          </div>
          <p className="mt-2 text-sm text-red-700 dark:text-red-300">{error.message}</p>
        </div>
      )}

      {/* Loading State */}
      {isLoading && !error && (
        <div className="flex items-center justify-center p-8 bg-gray-100 dark:bg-gray-800 rounded-lg">
          <div className="flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 dark:border-indigo-400"></div>
            <span className="text-sm text-gray-600 dark:text-gray-400">Loading app...</span>
          </div>
        </div>
      )}

      {/* MCP App iframe */}
      <div
        className={`${widthClass} ${heightClass} mx-auto bg-white dark:bg-gray-900 rounded-lg shadow-lg overflow-hidden border border-gray-200 dark:border-gray-700`}
        style={{ display: isLoading && !error ? 'none' : 'block' }}
      >
        <iframe
          ref={iframeRef}
          src={resourceUrl}
          sandbox={sandboxAttrs}
          title="MCP App"
          className="w-full h-full border-0"
          onLoad={handleIframeLoad}
          onError={handleIframeError}
          allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; microphone; midi; payment; usb; vr; xr-spatial-tracking"
        />
      </div>

      {/* Debug info (only in development) */}
      {process.env.NODE_ENV === 'development' && (
        <details className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          <summary className="cursor-pointer">Debug Info</summary>
          <pre className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded overflow-auto">
            {JSON.stringify(
              {
                resourceUri: uiMetadata.resourceUri,
                resourceUrl,
                sandbox: sandboxAttrs,
                permissions: uiMetadata.permissions,
                displayHints,
                isInitialized
              },
              null,
              2
            )}
          </pre>
        </details>
      )}
    </div>
  );
}

MCPAppRenderer.propTypes = {
  toolResult: PropTypes.object.isRequired,
  chatId: PropTypes.string,
  basePath: PropTypes.string
};
