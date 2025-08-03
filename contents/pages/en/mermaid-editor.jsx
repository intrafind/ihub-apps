function UserComponent(props) {
  const { React, useState, useEffect, useRef, useId } = props;
  
  // Main state
  const [mermaidCode, setMermaidCode] = useState(`graph TD
    A[Start] --> B{Is it working?}
    B -->|Yes| C[Great!]
    B -->|No| D[Debug]
    D --> B
    C --> E[End]`);
  const [theme, setTheme] = useState('light');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const diagramRef = useRef(null);
  const editorRef = useRef(null);
  const uniqueId = useId();

  // Examples data
  const examples = [
    {
      name: 'Flowchart',
      code: `graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E`
    },
    {
      name: 'Sequence',
      code: `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>B: Hello Bob, how are you?
    B-->>A: Great!
    A-)B: See you later!`
    },
    {
      name: 'Class Diagram',
      code: `classDiagram
    class Animal {
        +String name
        +int age
        +makeSound()
    }
    class Dog {
        +String breed
        +bark()
    }
    Animal <|-- Dog`
    },
    {
      name: 'Gantt Chart',
      code: `gantt
    title Project Timeline
    dateFormat  YYYY-MM-DD
    section Planning
    Research    :done, a1, 2024-01-01, 2024-01-15
    Design      :active, a2, 2024-01-10, 2024-01-25
    section Development
    Frontend    :a3, 2024-01-20, 2024-02-15
    Backend     :a4, 2024-01-25, 2024-02-20`
    },
    {
      name: 'Pie Chart',
      code: `pie title Favorite Programming Languages
    "JavaScript" : 35
    "Python" : 30
    "Java" : 20
    "Other" : 15`
    }
  ];

  // Global loading state to prevent conflicts
  if (!window.mermaidEditorState) {
    window.mermaidEditorState = {
      mermaidLoading: false,
      mermaidReady: false
    };
  }

  // Load Mermaid library only once globally
  useEffect(() => {
    if (window.mermaid) {
      setIsLoading(false);
      return;
    }

    if (window.mermaidEditorState.mermaidLoading) {
      // Another instance is loading, wait for it
      const checkReady = () => {
        if (window.mermaid) {
          setIsLoading(false);
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
      return;
    }

    // Mark as loading
    window.mermaidEditorState.mermaidLoading = true;

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/mermaid@10.6.1/dist/mermaid.min.js';
    script.onload = () => {
      if (window.mermaid) {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: 'default',
          securityLevel: 'loose',
          flowchart: {
            useMaxWidth: true,
            htmlLabels: true
          }
        });
        window.mermaidEditorState.mermaidReady = true;
        setIsLoading(false);
      }
    };
    script.onerror = () => {
      setError(new Error('Failed to load Mermaid library'));
      setIsLoading(false);
    };
    
    document.head.appendChild(script);
  }, []);

  // Render diagram
  const renderDiagram = async () => {
    if (!window.mermaid || isLoading || !mermaidCode.trim()) return;

    try {
      // Apply theme before rendering
      window.mermaid.initialize({ 
        theme: theme === 'dark' ? 'dark' : 'default',
        securityLevel: 'loose',
        flowchart: {
          useMaxWidth: true,
          htmlLabels: true
        }
      });

      // Clear previous diagram
      if (diagramRef.current) {
        diagramRef.current.innerHTML = '';
      }
      
      const diagramId = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const { svg } = await window.mermaid.render(diagramId, mermaidCode);
      setError(null);
      if (diagramRef.current) {
        diagramRef.current.innerHTML = svg;
      }
      
    } catch (err) {
      console.error('Diagram render error:', err);
      setError(err);
      if (diagramRef.current) {
        diagramRef.current.innerHTML = '';
      }
    }
  };

  // Effect to re-render diagram when code or theme changes
  useEffect(() => {
    if (!isLoading && window.mermaid) {
      const timeoutId = setTimeout(renderDiagram, 500);
      return () => clearTimeout(timeoutId);
    }
  }, [mermaidCode, theme, isLoading]);

  // Theme effect
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // Utility functions
  const handleExportSVG = () => {
    if (diagramRef.current) {
      const svgElement = diagramRef.current.querySelector('svg');
      if (svgElement) {
        const svgData = new XMLSerializer().serializeToString(svgElement);
        const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'mermaid-diagram.svg';
        a.click();
        URL.revokeObjectURL(url);
      }
    }
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(mermaidCode);
    } catch (err) {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = mermaidCode;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
  };

  const toggleTheme = () => {
    setTheme(prevTheme => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  return (
    <div className="fixed top-0 left-0 right-0 bottom-0 z-50 flex flex-col bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200">
      {/* Header & Toolbar */}
      <header className="flex-shrink-0 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-4 py-2">
        <div className="flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <button
              onClick={() => window.history.back()}
              className="flex items-center text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors p-2 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Mermaid Editor</h1>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={handleCopyCode} 
              title="Copy Code" 
              className="p-2 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button 
              onClick={handleExportSVG} 
              title="Export as SVG" 
              className="p-2 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </button>
            <div className="w-px h-6 bg-slate-300 dark:bg-slate-600 mx-1"></div>
            <button 
              onClick={toggleTheme} 
              title="Toggle Theme" 
              className="p-2 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            >
              {theme === 'light' ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>
      
      {/* Main Content */}
      <div className="flex-1 flex min-h-0">
        {/* Left Panel: Code Editor and Examples */}
        <div className="w-2/5 min-w-0 flex flex-col border-r border-slate-200 dark:border-slate-700">
          <div className="p-3 border-b border-slate-200 dark:border-slate-700">
            <h2 className="font-semibold mb-2 text-sm">Examples</h2>
            <div className="flex flex-wrap gap-2">
              {examples.map((ex) => (
                <button
                  key={ex.name}
                  onClick={() => setMermaidCode(ex.code)}
                  className="px-3 py-1 text-xs bg-slate-200 dark:bg-slate-700 rounded-full hover:bg-blue-500 hover:text-white transition-colors"
                >
                  {ex.name}
                </button>
              ))}
            </div>
          </div>
          
          {/* Simple Textarea Editor */}
          <div className="flex-1 relative">
            <textarea
              value={mermaidCode}
              onChange={(e) => setMermaidCode(e.target.value)}
              placeholder="Enter your Mermaid diagram code here..."
              className="w-full h-full p-4 font-mono text-sm resize-none border-none outline-none bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
              style={{ 
                fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                lineHeight: '1.5'
              }}
            />
          </div>
        </div>
        
        {/* Right Panel: Diagram Preview */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="p-3 border-b border-slate-200 dark:border-slate-700">
            <h2 className="font-semibold text-sm">Preview</h2>
          </div>
          <div className="flex-1 overflow-auto bg-white dark:bg-slate-900 p-4">
            {isLoading ? (
              <div className="flex items-center justify-center h-full text-slate-400">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
                Loading Mermaid...
              </div>
            ) : error ? (
              <div className="text-red-500 bg-red-50 dark:bg-red-900/20 p-4 rounded-lg border border-red-200 dark:border-red-800">
                <h3 className="font-bold mb-2">Diagram Error</h3>
                <pre className="text-sm whitespace-pre-wrap font-mono">{error.message}</pre>
                <div className="mt-3 text-sm">
                  <p>Common issues:</p>
                  <ul className="list-disc list-inside mt-1">
                    <li>Check for typos in node names and syntax</li>
                    <li>Ensure proper indentation</li>
                    <li>Verify diagram type is supported</li>
                  </ul>
                </div>
              </div>
            ) : (
              <div 
                ref={diagramRef}
                className="flex justify-center items-start min-h-full"
              />
            )}
          </div>
        </div>
      </div>

      {/* Footer / Status Bar */}
      <footer className="flex-shrink-0 text-xs px-4 py-1 bg-white dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400">
        <div className="flex justify-between items-center">
          <span>Powered by <a href="https://mermaid.js.org" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">Mermaid.js</a></span>
          <span>Auto-updates in real-time</span>
        </div>
      </footer>
    </div>
  );
}