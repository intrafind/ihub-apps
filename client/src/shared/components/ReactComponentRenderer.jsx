import React, { useState, useEffect, useMemo } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

// Error fallback component
const ErrorFallback = ({ error, resetErrorBoundary }) => (
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
        ></path>
      </svg>
      <h3 className="text-red-800 font-semibold">Component Error</h3>
    </div>
    <pre className="text-sm text-red-700 bg-red-100 p-3 rounded mb-4 overflow-auto">
      {error.message}
    </pre>
    <button
      onClick={resetErrorBoundary}
      className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
    >
      Try Again
    </button>
  </div>
);

// Loading component
const LoadingComponent = () => (
  <div className="flex items-center justify-center p-8">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    <span className="ml-3 text-gray-600">Compiling component...</span>
  </div>
);

const ReactComponentRenderer = ({ jsxCode, componentProps = {}, className = '' }) => {
  const [CompiledComponent, setCompiledComponent] = useState(null);
  const [compileError, setCompileError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Memoize the JSX code to prevent unnecessary recompilation
  const memoizedJsxCode = useMemo(() => jsxCode, [jsxCode]);

  useEffect(() => {
    let isMounted = true;

    const compileJSX = async () => {
      if (!memoizedJsxCode?.trim()) {
        setCompiledComponent(null);
        setCompileError(null);
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setCompileError(null);

        // Wait for Babel to be available
        if (typeof window.Babel === 'undefined') {
          // Try to load Babel if not already loaded
          await new Promise((resolve, reject) => {
            if (document.querySelector('script[src*="babel"]')) {
              resolve();
              return;
            }

            const script = document.createElement('script');
            script.src = 'https://unpkg.com/@babel/standalone/babel.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
          });
        }

        // Prepare the JSX code with imports and proper component structure
        let fullCode = memoizedJsxCode.trim();

        // Check if code already starts with import or const/function declarations
        const hasImports = /^(import\s|const\s|function\s|class\s|export\s)/m.test(fullCode);

        if (!hasImports) {
          // Wrap standalone JSX in a functional component
          fullCode = `
function UserComponent(props) {
  const { React, useState, useEffect, useMemo, useCallback, useRef } = props;
  
  return (
    ${fullCode}
  );
}

UserComponent;
          `;
        } else {
          // Code has proper structure, just ensure it exports a component
          if (!fullCode.includes('export default')) {
            fullCode += `\n\nexport default UserComponent;`;
          }
        }

        // Transform JSX to JS using Babel
        const transformed = window.Babel.transform(fullCode, {
          presets: ['react'],
          plugins: []
        });

        // Create a safe execution context
        const executeInContext = new Function(
          'React',
          'useState',
          'useEffect',
          'useMemo',
          'useCallback',
          'useRef',
          'props',
          `
          try {
            ${transformed.code}
            return typeof UserComponent !== 'undefined' ? UserComponent : 
                   typeof module !== 'undefined' && module.exports ? module.exports.default || module.exports :
                   null;
          } catch (error) {
            console.error('Runtime error in user component:', error);
            throw error;
          }
          `
        );

        // Execute the compiled code
        const ComponentFunction = executeInContext(
          React,
          React.useState,
          React.useEffect,
          React.useMemo,
          React.useCallback,
          React.useRef,
          componentProps
        );

        if (!ComponentFunction) {
          throw new Error('No component was exported from the provided code');
        }

        // Create a wrapper component that provides the React hooks as props
        const WrappedComponent = props => {
          const combinedProps = {
            ...componentProps,
            ...props,
            React,
            useState: React.useState,
            useEffect: React.useEffect,
            useMemo: React.useMemo,
            useCallback: React.useCallback,
            useRef: React.useRef
          };

          return React.createElement(ComponentFunction, combinedProps);
        };

        if (isMounted) {
          setCompiledComponent(() => WrappedComponent);
          setCompileError(null);
        }
      } catch (error) {
        console.error('JSX compilation error:', error);
        if (isMounted) {
          setCompileError(error.message || 'Failed to compile JSX');
          setCompiledComponent(null);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    compileJSX();

    return () => {
      isMounted = false;
    };
  }, [memoizedJsxCode, componentProps]);

  if (isLoading) {
    return <LoadingComponent />;
  }

  if (compileError) {
    return (
      <div className="border-2 border-yellow-200 rounded-lg p-6 bg-yellow-50">
        <div className="flex items-center mb-4">
          <svg
            className="w-6 h-6 text-yellow-600 mr-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.082 16.5c-.77.833.192 2.5 1.732 2.5z"
            ></path>
          </svg>
          <h3 className="text-yellow-800 font-semibold">Compilation Error</h3>
        </div>
        <pre className="text-sm text-yellow-700 bg-yellow-100 p-3 rounded overflow-auto">
          {compileError}
        </pre>
      </div>
    );
  }

  if (!CompiledComponent) {
    return <div className="text-center py-8 text-gray-500">No component to render</div>;
  }

  return (
    <div className={`react-component-container ${className}`}>
      <ErrorBoundary
        FallbackComponent={ErrorFallback}
        onReset={() => {
          // Force recompilation on reset
          setCompiledComponent(null);
          setIsLoading(true);
        }}
      >
        <CompiledComponent />
      </ErrorBoundary>
    </div>
  );
};

export default ReactComponentRenderer;
