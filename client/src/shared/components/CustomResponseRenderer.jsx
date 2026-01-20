import { useState, useEffect, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactComponentRenderer from './ReactComponentRenderer';

/**
 * CustomResponseRenderer - Renders custom response components for structured app outputs
 *
 * This component dynamically loads and renders custom React components
 * to display structured JSON responses in a user-friendly format.
 *
 * Renderers are loaded from the backend API (/api/renderers/:id) which serves
 * both built-in renderers (from server/defaults/renderers) and customer-specific
 * renderers (from contents/renderers).
 *
 * @param {string} componentName - Name of the renderer component (e.g., 'nda-results')
 * @param {object} data - Parsed JSON data to pass to the component
 * @param {string} className - Optional CSS classes for the container
 */
const CustomResponseRenderer = ({ componentName, data, className = '' }) => {
  const [rendererCode, setRendererCode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { t } = useTranslation();

  useEffect(() => {
    const loadRendererFromAPI = async () => {
      try {
        setLoading(true);
        setError(null);

        // Fetch renderer code from API
        const response = await fetch(`/api/renderers/${componentName}`);
        
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(`Renderer "${componentName}" not found`);
          } else if (response.status === 403) {
            throw new Error(`Renderer "${componentName}" is disabled`);
          }
          throw new Error(`Failed to load renderer: ${response.statusText}`);
        }

        const renderer = await response.json();
        
        if (!renderer.code) {
          throw new Error(`Renderer "${componentName}" has no code`);
        }

        setRendererCode(renderer.code);
      } catch (err) {
        console.error('Error loading custom response renderer:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    if (componentName) {
      loadRendererFromAPI();
    }
  }, [componentName]);

  // Prepare props for the renderer component
  const componentProps = useMemo(() => ({
    data,
    t,
    // Add React hooks that the renderer might need
    React: require('react'),
    useState: require('react').useState,
    useEffect: require('react').useEffect,
    useMemo: require('react').useMemo,
    useCallback: require('react').useCallback,
    useRef: require('react').useRef
  }), [data, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600">{t('common.loading', 'Loading...')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border-2 border-red-200 rounded-lg p-6 bg-red-50">
        <div className="flex items-center mb-4">
          <svg
            className="w-6 h-6 text-red-600 mr-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h3 className="text-red-800 font-semibold">
            {t('errors.rendererError', 'Renderer Error')}
          </h3>
        </div>
        <p className="text-sm text-red-700">{error}</p>
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-red-600 hover:text-red-800">
            {t('common.details', 'Details')}
          </summary>
          <pre className="text-xs text-red-700 bg-red-100 p-3 rounded mt-2 overflow-auto">
            Renderer: {componentName}
            {'\n'}
            Error: {error}
            {'\n'}
            Data: {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      </div>
    );
  }

  if (!rendererCode) {
    return (
      <div className="text-center py-8 text-gray-500">
        {t('errors.noComponentFound', 'No renderer found')}
      </div>
    );
  }

  // Use ReactComponentRenderer to compile and render the JSX code
  return (
    <div className={className}>
      <Suspense
        fallback={
          <div className="flex items-center justify-center p-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        }
      >
        <ReactComponentRenderer
          jsxCode={rendererCode}
          componentProps={componentProps}
        />
      </Suspense>
    </div>
  );
};

export default CustomResponseRenderer;
