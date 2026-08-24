import React, { useState, useEffect, useRef } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

// Error fallback component
function ErrorFallback({ error, resetErrorBoundary, t }) {
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
}

// Loading component
function LoadingComponent({ t }) {
  return (
    <div className="flex items-center justify-center p-8">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      <span className="ml-3 text-gray-600">
        {t ? t('common.compiling', 'Compiling component...') : 'Compiling component...'}
      </span>
    </div>
  );
}

// Cached across renders/mounts so the bundled @babel/standalone chunk is only
// ever fetched once, rather than on every JSX compile.
let babelModulePromise;
function loadBabel() {
  babelModulePromise ??= import('@babel/standalone');
  return babelModulePromise;
}

function ReactComponentRenderer({ jsxCode, componentProps = {}, className = '' }) {
  const [ComponentFunction, setComponentFunction] = useState(null);
  const [compileError, setCompileError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Extract t function for internal components
  const { t } = componentProps;

  // Keep a ref so the wrapper always reads the latest props without
  // triggering recompilation when componentProps changes object identity.
  const componentPropsRef = useRef(componentProps);
  componentPropsRef.current = componentProps;

  useEffect(() => {
    let isMounted = true;

    const compileJSX = async () => {
      if (!jsxCode?.trim()) {
        setComponentFunction(null);
        setCompileError(null);
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setCompileError(null);

        // Load the bundled @babel/standalone chunk (lazy, cached across compiles).
        const BabelModule = await loadBabel();
        const Babel = BabelModule.default ?? BabelModule;

        // Prepare the JSX code with imports and proper component structure
        let fullCode = jsxCode.trim();

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
          const transformMethod = Babel.transformSync || Babel.transform;
          if (!transformMethod) {
            throw new Error('No Babel transform method available');
          }

          transformed = transformMethod(fullCode, {
            // Force the classic JSX runtime so Babel emits React.createElement
            // calls. The execution context below only injects `React`; it does
            // not provide the react/jsx-runtime imports (_jsx/_jsxs) that the
            // automatic runtime relies on. Newer @babel/standalone builds
            // default to the automatic runtime, which produced
            // "_jsxs is not defined" at render time.
            presets: [['react', { runtime: 'classic' }]],
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
        executableCode = executableCode.replace(
          /(?:^|\n)\s*(?:var|const|let)\s+\w+\s*=\s*require\([^)]+\);?\s*/gm,
          ''
        );
        executableCode = executableCode.replace(
          /(?:^|\n)\s*import\s+.*?from\s+['"][^'"]+['"];?\s*/gm,
          ''
        );

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

        // Execute the compiled code to extract the component function
        const compiledFn = executeInContext(
          React,
          React.useState,
          React.useEffect,
          React.useMemo,
          React.useCallback,
          React.useRef,
          React.useId,
          {}
        );

        if (!compiledFn) {
          throw new Error('No component was exported from the provided code');
        }

        if (isMounted) {
          setComponentFunction(() => compiledFn);
          setCompileError(null);
        }
      } catch (error) {
        console.error('JSX compilation error:', error);
        if (isMounted) {
          setCompileError(error.message || 'Failed to compile JSX');
          setComponentFunction(null);
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
  }, [jsxCode]);

  // Build the props the compiled component should receive. Recomputed on
  // every render so the user component always sees the latest external
  // props; React's reconciliation keeps the compiled component's state
  // stable as long as ComponentFunction's identity is unchanged.
  const compiledChildProps = {
    ...componentPropsRef.current,
    React,
    useState: React.useState,
    useEffect: React.useEffect,
    useMemo: React.useMemo,
    useCallback: React.useCallback,
    useRef: React.useRef,
    useId: React.useId
  };

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

  if (!ComponentFunction) {
    return (
      <div className="text-center py-8 text-gray-500">
        {t('errors.noComponentToRender', 'No component to render')}
      </div>
    );
  }

  return (
    <div className={`react-component-container ${className}`}>
      <ErrorBoundary
        fallbackRender={fallbackProps => <ErrorFallback {...fallbackProps} t={t} />}
        onReset={() => {
          // Force recompilation on reset
          setComponentFunction(null);
          setIsLoading(true);
        }}
      >
        {React.createElement(ComponentFunction, compiledChildProps)}
      </ErrorBoundary>
    </div>
  );
}

export default ReactComponentRenderer;
