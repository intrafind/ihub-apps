# Custom Response Renderers

Custom response renderers allow you to create beautiful, interactive UI components for displaying structured JSON responses from AI applications. Instead of showing raw JSON or plain text, you can build custom React components that render data in user-friendly formats.

## Overview

The custom renderer system provides:

- **No Client Rebuilds**: Add or modify renderers without recompiling the frontend
- **Customer Override Pattern**: Custom renderers in `contents/renderers/` override built-in ones
- **React Components**: Full React hooks support with dynamic JSX compilation
- **Isolated Execution**: Safe, sandboxed component execution in the browser
- **Easy Integration**: Simply drop a `.jsx` file and reference it in your app config

## Architecture

```
Backend (Server):
  ├── server/defaults/renderers/     # Built-in renderers
  ├── contents/renderers/            # Customer-specific renderers (override defaults)
  ├── renderersLoader.js             # Service layer for loading renderers
  └── routes/rendererRoutes.js       # API endpoints

Frontend (Client):
  ├── CustomResponseRenderer.jsx     # Fetches and displays renderers
  └── ReactComponentRenderer.jsx     # Compiles JSX using Babel Standalone
```

## How It Works

1. **Backend**: `renderersLoader.js` scans both `defaults/renderers/` and `contents/renderers/`
2. **Override**: Renderers in `contents/` override built-in renderers with the same ID
3. **API**: Renderer code is served via `/api/renderers/:id`
4. **Frontend**: `CustomResponseRenderer` fetches code and uses Babel to compile JSX
5. **Execution**: Component runs in isolated scope with provided props

## Creating a Custom Renderer

### Step 1: Create the Renderer File

Create a `.jsx` file in either:
- `server/defaults/renderers/` (for built-in renderers)
- `contents/renderers/` (for customer-specific renderers that override defaults)

The filename (without extension) becomes the renderer ID.

**Example**: `contents/renderers/my-custom-renderer.jsx`

### Step 2: Write the Component

Your renderer must export a component named `UserComponent` that receives props:

```jsx
import { useState } from 'react';

/**
 * MyCustomRenderer - Example custom renderer
 * Displays structured data in a custom format
 */
const MyCustomRenderer = ({ data, t }) => {
  // Access data from the AI response
  const items = data.items || [];
  
  return (
    <div className="space-y-4 p-4">
      <h2 className="text-2xl font-bold text-gray-800">
        {t ? t('myRenderer.title', 'Results') : 'Results'}
      </h2>
      
      <div className="grid grid-cols-2 gap-4">
        {items.map((item, idx) => (
          <div key={idx} className="border rounded-lg p-4 bg-white shadow">
            <h3 className="font-semibold">{item.name}</h3>
            <p className="text-sm text-gray-600">{item.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default MyCustomRenderer;
```

### Step 3: Reference in App Config

Add the `customResponseRenderer` field to your app configuration:

```json
{
  "id": "my-app",
  "name": { "en": "My App" },
  "customResponseRenderer": "my-custom-renderer",
  "outputSchema": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "description": { "type": "string" }
          }
        }
      }
    }
  }
}
```

## Available Props

Your renderer component receives the following props:

| Prop | Type | Description |
|------|------|-------------|
| `data` | Object | The parsed JSON response from the AI |
| `t` | Function | Translation function for i18n support |
| `React` | Object | React library (for JSX) |
| `useState` | Function | React hook for state management |
| `useEffect` | Function | React hook for side effects |
| `useMemo` | Function | React hook for memoization |
| `useCallback` | Function | React hook for callback memoization |
| `useRef` | Function | React hook for refs |

## Example: Using React Hooks

```jsx
const InteractiveRenderer = ({ data, t, useState, useEffect }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [processedData, setProcessedData] = useState([]);
  
  useEffect(() => {
    // Process data when component mounts
    const processed = data.items.map(item => ({
      ...item,
      formattedDate: new Date(item.timestamp).toLocaleDateString()
    }));
    setProcessedData(processed);
  }, [data]);
  
  return (
    <div>
      <button 
        onClick={() => setIsExpanded(!isExpanded)}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
      >
        {isExpanded ? 'Collapse' : 'Expand'}
      </button>
      
      {isExpanded && (
        <div className="mt-4 space-y-2">
          {processedData.map((item, idx) => (
            <div key={idx} className="border-l-4 border-blue-500 pl-4 py-2">
              <p className="font-medium">{item.title}</p>
              <p className="text-sm text-gray-500">{item.formattedDate}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default InteractiveRenderer;
```

## Styling with Tailwind CSS

All renderers have access to Tailwind CSS utility classes:

```jsx
const StyledRenderer = ({ data }) => {
  return (
    <div className="max-w-4xl mx-auto">
      {/* Color-coded status */}
      <div className={`p-4 rounded-lg ${
        data.status === 'success' ? 'bg-green-50 border-green-300' :
        data.status === 'warning' ? 'bg-yellow-50 border-yellow-300' :
        'bg-red-50 border-red-300'
      } border-2`}>
        <h3 className="text-lg font-semibold">{data.message}</h3>
      </div>
      
      {/* Responsive grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
        {data.cards.map((card, idx) => (
          <div key={idx} className="bg-white rounded-lg shadow-md p-4 hover:shadow-lg transition-shadow">
            <p>{card.content}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default StyledRenderer;
```

## Internationalization (i18n)

Use the `t` function for translating text:

```jsx
const I18nRenderer = ({ data, t }) => {
  return (
    <div>
      <h2>{t ? t('renderer.title', 'Default Title') : 'Default Title'}</h2>
      <p>{t ? t('renderer.description', 'Default description') : 'Default description'}</p>
      
      {/* Always provide fallback for when t is undefined */}
      <button>
        {t('common.submit', 'Submit')}
      </button>
    </div>
  );
};
```

Add translations to your locale files:
- `shared/i18n/en.json`
- `shared/i18n/de.json`
- Or override in `contents/locales/en.json`

## Error Handling

The renderer system includes automatic error handling:

```jsx
const SafeRenderer = ({ data, t }) => {
  // Validate data structure
  if (!data || !data.results) {
    return (
      <div className="p-4 text-center text-gray-500">
        {t ? t('renderer.noData', 'No data available') : 'No data available'}
      </div>
    );
  }
  
  // Handle empty arrays
  if (data.results.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        {t ? t('renderer.noResults', 'No results found') : 'No results found'}
      </div>
    );
  }
  
  // Render data
  return (
    <div className="space-y-4">
      {data.results.map((result, idx) => (
        <div key={idx}>{result.content}</div>
      ))}
    </div>
  );
};

export default SafeRenderer;
```

## Complete Example: NDA Risk Analyzer

The NDA Risk Analyzer renderer demonstrates advanced features:

**File**: `server/defaults/renderers/nda-results.jsx`

Key features:
- Color-coded risk levels (red/yellow/green)
- Summary statistics
- Expandable citation sections
- Shared helper functions at module level
- Comprehensive i18n support
- Nested components with state management

```jsx
import { useState } from 'react';

// Shared helper functions (module level)
const getRiskColorClasses = level => {
  switch (level?.toLowerCase()) {
    case 'red': return { container: 'bg-red-50', text: 'text-red-900', ... };
    case 'yellow': return { container: 'bg-yellow-50', text: 'text-yellow-900', ... };
    case 'green': return { container: 'bg-green-50', text: 'text-green-900', ... };
    default: return { container: 'bg-gray-50', text: 'text-gray-900', ... };
  }
};

const NDAResultsRenderer = ({ data, t }) => {
  if (!data || !data.clauses) {
    return <div className="p-4 text-center text-gray-500">No data</div>;
  }
  
  const overallColors = getRiskColorClasses(data.overall_risk);
  
  return (
    <div className="space-y-6 p-4">
      {/* Overall Risk Summary */}
      <div className={`rounded-lg border-2 ${overallColors.container} p-6`}>
        <h2 className={`text-2xl font-bold ${overallColors.text}`}>
          {t('nda.overallRisk', 'Overall Risk Assessment')}
        </h2>
      </div>
      
      {/* Clause Cards */}
      {data.clauses.map((clause, idx) => (
        <ClauseCard key={idx} clause={clause} t={t} />
      ))}
    </div>
  );
};

// Nested component with its own state
const ClauseCard = ({ clause, t }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const colors = getRiskColorClasses(clause.risk_level);
  
  return (
    <div className={`rounded-lg border ${colors.container}`}>
      <div className="p-4">
        <h4 className={colors.text}>{clause.clause_name}</h4>
        <p>{clause.reason}</p>
        
        {clause.citation && clause.citation.length > 0 && (
          <button onClick={() => setIsExpanded(!isExpanded)}>
            {isExpanded ? 'Hide Citations' : `Show Citations (${clause.citation.length})`}
          </button>
        )}
        
        {isExpanded && (
          <div className="mt-3 space-y-2">
            {clause.citation.map((cite, idx) => (
              <div key={idx} className="p-3 border-l-2">
                <p>&quot;{cite}&quot;</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default NDAResultsRenderer;
```

## Best Practices

### 1. Code Organization

```jsx
// ✅ Good: Module-level helpers (shared across components)
const formatDate = (timestamp) => new Date(timestamp).toLocaleDateString();

const MyRenderer = ({ data }) => {
  return <div>{formatDate(data.timestamp)}</div>;
};

// ❌ Bad: Defining helpers inside component (recreated on every render)
const MyRenderer = ({ data }) => {
  const formatDate = (timestamp) => new Date(timestamp).toLocaleDateString();
  return <div>{formatDate(data.timestamp)}</div>;
};
```

### 2. Avoid Duplication

Extract shared logic to module-level functions to reduce code duplication and improve maintainability.

### 3. Data Validation

Always validate the data structure before rendering:

```jsx
const MyRenderer = ({ data, t }) => {
  // Validate required fields
  if (!data || !data.items || !Array.isArray(data.items)) {
    return <div>Invalid data structure</div>;
  }
  
  // Render safely
  return <div>{/* ... */}</div>;
};
```

### 4. Performance

Use React hooks properly to optimize performance:

```jsx
const OptimizedRenderer = ({ data, useMemo }) => {
  // Memoize expensive calculations
  const processedData = useMemo(() => {
    return data.items.map(item => ({
      ...item,
      calculated: expensiveCalculation(item)
    }));
  }, [data]);
  
  return <div>{/* Use processedData */}</div>;
};
```

### 5. Accessibility

Include proper semantic HTML and ARIA attributes:

```jsx
const AccessibleRenderer = ({ data }) => {
  return (
    <div role="region" aria-label="Results">
      <h2 id="results-heading">Results</h2>
      <ul aria-labelledby="results-heading">
        {data.items.map((item, idx) => (
          <li key={idx} tabIndex={0}>
            {item.title}
          </li>
        ))}
      </ul>
    </div>
  );
};
```

## Testing Your Renderer

### 1. Check API Endpoint

Verify your renderer is available:

```bash
curl http://localhost:3000/api/renderers
```

Get specific renderer:

```bash
curl http://localhost:3000/api/renderers/my-custom-renderer
```

### 2. Test in Browser

1. Create or modify an app to use your renderer
2. Send a test message to generate a response
3. Verify the renderer displays correctly
4. Check browser console for any errors

### 3. Test with Sample Data

Create a test file to verify your renderer logic:

```javascript
// test-renderer.js
import { readFileSync } from 'fs';

const rendererCode = readFileSync('contents/renderers/my-renderer.jsx', 'utf8');
const sampleData = {
  items: [
    { name: 'Item 1', description: 'Test item 1' },
    { name: 'Item 2', description: 'Test item 2' }
  ]
};

console.log('Renderer code loaded successfully');
console.log('Sample data:', JSON.stringify(sampleData, null, 2));
```

## Troubleshooting

### Renderer Not Loading

**Problem**: Renderer doesn't appear or shows "Renderer not found"

**Solutions**:
- Check the renderer ID matches the filename (without `.jsx`)
- Verify the file is in `server/defaults/renderers/` or `contents/renderers/`
- Restart the server to reload renderers
- Check server logs for loading errors

### Compilation Errors

**Problem**: "Compilation Error" or "Failed to compile JSX"

**Solutions**:
- Verify JSX syntax is correct
- Check that component is named `UserComponent` or exported as default
- Ensure all JSX tags are properly closed
- Check for balanced braces and parentheses

### Component Not Rendering

**Problem**: Component compiles but nothing displays

**Solutions**:
- Check that component returns JSX (not `null` or `undefined`)
- Verify data structure matches expected format
- Add console.log statements to debug
- Check browser console for runtime errors

### Styling Not Working

**Problem**: Tailwind classes don't apply styles

**Solutions**:
- Verify class names are valid Tailwind utilities
- Check for typos in class names
- Ensure you're using the latest Tailwind version
- Verify the browser has loaded Tailwind CSS

## API Reference

### `/api/renderers`

**GET** - List all available renderers

**Response**:
```json
[
  {
    "id": "nda-results",
    "filename": "nda-results.jsx",
    "source": "defaults"
  },
  {
    "id": "my-custom-renderer",
    "filename": "my-custom-renderer.jsx",
    "source": "contents"
  }
]
```

### `/api/renderers/:id`

**GET** - Get specific renderer code

**Parameters**:
- `id` - Renderer ID (filename without extension)

**Response**:
```json
{
  "id": "my-custom-renderer",
  "filename": "my-custom-renderer.jsx",
  "source": "contents",
  "code": "import { useState } from 'react'; ..."
}
```

**Error Responses**:
- `404` - Renderer not found
- `403` - Renderer is disabled
- `500` - Server error

## Advanced Topics

### Dynamic Content Loading

Load additional data or resources from external APIs:

```jsx
const DynamicRenderer = ({ data, useEffect, useState }) => {
  const [additionalData, setAdditionalData] = useState(null);
  
  useEffect(() => {
    if (data.referenceId) {
      fetch(`/api/reference/${data.referenceId}`)
        .then(res => res.json())
        .then(setAdditionalData);
    }
  }, [data.referenceId]);
  
  return (
    <div>
      <div>Main data: {data.content}</div>
      {additionalData && <div>Additional: {additionalData.details}</div>}
    </div>
  );
};
```

### Chart and Visualization Libraries

While external libraries aren't directly importable, you can use inline SVG or Canvas:

```jsx
const ChartRenderer = ({ data }) => {
  const maxValue = Math.max(...data.values);
  
  return (
    <svg width="400" height="200" className="border">
      {data.values.map((value, idx) => (
        <rect
          key={idx}
          x={idx * 50}
          y={200 - (value / maxValue) * 180}
          width="40"
          height={(value / maxValue) * 180}
          fill="#3B82F6"
        />
      ))}
    </svg>
  );
};
```

### Complex State Management

For renderers with complex state, organize state logically:

```jsx
const ComplexRenderer = ({ data, useState, useCallback }) => {
  const [state, setState] = useState({
    activeTab: 'overview',
    filters: { category: 'all', status: 'all' },
    sortBy: 'name',
    sortOrder: 'asc'
  });
  
  const updateFilter = useCallback((key, value) => {
    setState(prev => ({
      ...prev,
      filters: { ...prev.filters, [key]: value }
    }));
  }, []);
  
  const filteredData = data.items.filter(item => {
    if (state.filters.category !== 'all' && item.category !== state.filters.category) {
      return false;
    }
    if (state.filters.status !== 'all' && item.status !== state.filters.status) {
      return false;
    }
    return true;
  });
  
  return <div>{/* Render filtered data */}</div>;
};
```

## Summary

Custom renderers provide a powerful way to create beautiful, interactive UIs for your AI applications:

- ✅ No frontend rebuilds required
- ✅ Full React hooks support
- ✅ Customer override capability
- ✅ Tailwind CSS styling
- ✅ i18n translation support
- ✅ Safe, isolated execution
- ✅ Easy to create and maintain

For more examples, see the built-in renderers in `server/defaults/renderers/`.
