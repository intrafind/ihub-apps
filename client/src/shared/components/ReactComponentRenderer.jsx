import React, { useState, useEffect, useMemo } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

// Error fallback component
const ErrorFallback = ({ error, resetErrorBoundary, t }) => (
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
      <h3 className="text-red-800 font-semibold">
        {t ? t('errors.componentError', 'Component Error') : 'Component Error'}
      </h3>
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
const LoadingComponent = ({ t }) => (
  <div className="flex items-center justify-center p-8">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    <span className="ml-3 text-gray-600">
      {t ? t('common.compiling', 'Compiling component...') : 'Compiling component...'}
    </span>
  </div>
);

const ReactComponentRenderer = ({ jsxCode, componentProps = {}, className = '' }) => {
  const [CompiledComponent, setCompiledComponent] = useState(null);
  const [compileError, setCompileError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Extract t function for internal components
  const { t } = componentProps;

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
        if (!window.Babel || (!window.Babel.transform && !window.Babel.transformSync)) {
          // Try to load Babel if not already loaded
          await new Promise((resolve, reject) => {
            const existingScript = document.querySelector('script[src*="babel"]');

            if (
              existingScript &&
              window.Babel &&
              (window.Babel.transform || window.Babel.transformSync)
            ) {
              resolve();
              return;
            }

            // Remove any existing incomplete Babel script
            if (existingScript) {
              existingScript.remove();
            }

            const babelUrls = [
              'https://unpkg.com/@babel/standalone/babel.min.js',
              'https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js'
            ];

            let urlIndex = 0;

            const tryLoadBabel = () => {
              if (urlIndex >= babelUrls.length) {
                reject(new Error('Failed to load Babel from all CDN sources'));
                return;
              }

              const script = document.createElement('script');
              script.src = babelUrls[urlIndex];
              script.onload = () => {
                // Wait a bit for Babel to fully initialize
                setTimeout(() => {
                  if (window.Babel && (window.Babel.transform || window.Babel.transformSync)) {
                    console.log('✅ Babel loaded successfully:', {
                      hasTransform: !!window.Babel.transform,
                      hasTransformSync: !!window.Babel.transformSync,
                      availableMethods: Object.keys(window.Babel)
                    });
                    resolve();
                  } else {
                    console.error('❌ Babel object:', window.Babel);
                    reject(new Error('Babel failed to initialize properly'));
                  }
                }, 150);
              };
              script.onerror = () => {
                script.remove();
                urlIndex++;
                tryLoadBabel();
              };
              document.head.appendChild(script);
            };

            tryLoadBabel();
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
  const { React, useState, useEffect, useMemo, useCallback, useRef, useId } = props;
  
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
        let transformed;
        try {
          // Use transformSync if available, otherwise fallback to transform
          const transformMethod = window.Babel.transformSync || window.Babel.transform;
          if (!transformMethod) {
            throw new Error('No Babel transform method available');
          }

          transformed = transformMethod(fullCode, {
            presets: ['react'],
            plugins: []
          });
        } catch (babelError) {
          console.error('Babel transform error:', babelError);
          throw new Error(`Babel transformation failed: ${babelError.message}`);
        }

        if (!transformed || !transformed.code) {
          throw new Error('Babel transformation returned no code');
        }

        // Remove import and export statements since new Function() can't handle them
        let executableCode = transformed.code;
        
        // Remove import statements (Babel transforms them to require() which won't work in new Function())
        executableCode = executableCode.replace(/(?:^|\n)\s*(?:var|const|let)\s+\w+\s*=\s*require\([^)]+\);?\s*/gm, '');
        executableCode = executableCode.replace(/(?:^|\n)\s*import\s+.*?from\s+['"][^'"]+['"];?\s*/gm, '');
        
        // Remove export statements
        executableCode = executableCode.replace(/export\s+default\s+\w+;?\s*$/, '');
        executableCode = executableCode.replace(/export\s*\{[^}]*\}.*;?\s*$/, '');

        // Create a safe execution context
        const executeInContext = new Function(
          'React',
          'useState',
          'useEffect',
          'useMemo',
          'useCallback',
          'useRef',
          'useId',
          'props',
          `
          try {
            ${executableCode}
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
          React.useId,
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
            useRef: React.useRef,
            useId: React.useId
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
    return <LoadingComponent t={t} />;
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
          <h3 className="text-yellow-800 font-semibold">
            {t('errors.compilationError', 'Compilation Error')}
          </h3>
        </div>
        <pre className="text-sm text-yellow-700 bg-yellow-100 p-3 rounded overflow-auto">
          {compileError}
        </pre>
      </div>
    );
  }

  if (!CompiledComponent) {
    return (
      <div className="text-center py-8 text-gray-500">
        {t('errors.noComponentToRender', 'No component to render')}
      </div>
    );
  }

  return (
    <div className={`react-component-container ${className}`}>
      <ErrorBoundary
        FallbackComponent={props => <ErrorFallback {...props} t={t} />}
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
