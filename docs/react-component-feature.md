# React Component Rendering Feature

iHub Apps now supports rendering interactive React components directly from JSX files. This powerful feature allows you to create dynamic, interactive pages alongside traditional markdown content.

## Overview

The React component rendering system automatically detects JSX code and compiles it in the browser using Babel, providing a seamless way to create interactive components without a complex build process.

## How It Works

### Architecture

1. **Auto-Detection**: The system automatically detects React/JSX content based on code patterns
2. **Babel Compilation**: JSX code is compiled to JavaScript in the browser using Babel Standalone
3. **Safe Execution**: Components run in a controlled environment with access to React hooks and props
4. **Error Handling**: Comprehensive error boundaries with clear feedback

### Component Detection

The system identifies React components by looking for these patterns in the content:

- `import` statements
- `export` statements
- `function` declarations
- JSX syntax (`<ComponentName>`)
- React hooks (`useState`, `useEffect`, etc.)
- `React.` references

## Creating React Components

### File Location

Create React component files in the pages directory:

```
contents/pages/{language}/{component-name}.jsx
```

Example: `contents/pages/en/qr-generator.jsx`

### Component Structure

Your component should be named `UserComponent` and receive props:

```jsx
function UserComponent(props) {
  const { React, useState, useEffect, useRef } = props;

  const [count, setCount] = useState(0);

  return (
    <div className="p-4">
      <h1>Interactive Component</h1>
      <p>Count: {count}</p>
      <button
        onClick={() => setCount(count + 1)}
        className="bg-blue-500 text-white px-4 py-2 rounded"
      >
        Increment
      </button>
    </div>
  );
}
```

### Available Props

Your component automatically receives these props:

#### React Hooks

- `React` - React library
- `useState` - State hook
- `useEffect` - Effect hook
- `useMemo` - Memoization hook
- `useCallback` - Callback hook
- `useRef` - Reference hook

#### Application Context

- `t` - Translation function for internationalization
- `navigate` - Router navigation function
- `user` - User data object (includes language preference)

### Styling

Use Tailwind CSS classes for styling. The component inherits the application's Tailwind configuration:

```jsx
function UserComponent(props) {
  const { React } = props;

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">My Component</h1>
        <p className="text-gray-600">Styled with Tailwind CSS</p>
      </div>
    </div>
  );
}
```

## Examples

### Simple Interactive Counter

```jsx
function UserComponent(props) {
  const { React, useState } = props;
  const [count, setCount] = useState(0);

  return (
    <div className="text-center p-8">
      <h2 className="text-2xl font-bold mb-4">Counter: {count}</h2>
      <div className="space-x-4">
        <button
          onClick={() => setCount(count - 1)}
          className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600"
        >
          Decrease
        </button>
        <button
          onClick={() => setCount(count + 1)}
          className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600"
        >
          Increase
        </button>
      </div>
    </div>
  );
}
```

### Form with Local Storage

```jsx
function UserComponent(props) {
  const { React, useState, useEffect } = props;
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const savedName = localStorage.getItem('userName');
    if (savedName) {
      setName(savedName);
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem('userName', name);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="max-w-md mx-auto p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-xl font-bold mb-4">Save Your Name</h2>
      <div className="space-y-4">
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Enter your name"
          className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleSave}
          className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600"
        >
          {saved ? 'Saved!' : 'Save Name'}
        </button>
      </div>
    </div>
  );
}
```

### Using External Libraries

You can load external libraries dynamically:

```jsx
function UserComponent(props) {
  const { React, useState, useEffect, useRef } = props;
  const chartRef = useRef(null);

  useEffect(() => {
    // Load Chart.js dynamically
    if (!window.Chart) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
      script.onload = () => {
        createChart();
      };
      document.head.appendChild(script);
    } else {
      createChart();
    }
  }, []);

  const createChart = () => {
    if (chartRef.current) {
      new window.Chart(chartRef.current, {
        type: 'bar',
        data: {
          labels: ['Red', 'Blue', 'Yellow', 'Green'],
          datasets: [
            {
              label: 'Votes',
              data: [12, 19, 3, 5],
              backgroundColor: ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0']
            }
          ]
        }
      });
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h2 className="text-2xl font-bold mb-4">Dynamic Chart</h2>
      <canvas ref={chartRef} width="400" height="200"></canvas>
    </div>
  );
}
```

## Best Practices

### Component Structure

- Always name your main component `UserComponent`
- Destructure needed props at the component top
- Use functional components with hooks
- Keep components focused and single-purpose

### Performance

- Use `useMemo` and `useCallback` for expensive operations
- Avoid creating objects in render cycles
- Clean up effects and event listeners in `useEffect` cleanup

### Error Handling

- Wrap risky operations in try-catch blocks
- Provide fallback UI for loading states
- Handle async operations properly

### Accessibility

- Use semantic HTML elements
- Include proper ARIA labels
- Ensure keyboard navigation works
- Maintain good color contrast

## Troubleshooting

### Common Issues

#### Component Not Rendering

- Check that your component is named `UserComponent`
- Ensure the file has a `.jsx` extension
- Verify JSX syntax is correct

#### Babel Compilation Errors

- Check for syntax errors in your JSX
- Ensure you're not using unsupported JavaScript features
- Avoid `export` statements (these are handled automatically)

#### Missing Dependencies

- External libraries must be loaded dynamically
- Check browser console for loading errors
- Verify CDN URLs are accessible

#### State Not Updating

- Ensure you're using the `useState` hook correctly
- Check that state updates are not mutating existing state
- Verify event handlers are bound properly

### Error Messages

The system provides detailed error messages:

#### Compilation Errors (Yellow Box)

- Babel transformation failures
- JSX syntax errors
- Missing component exports

#### Runtime Errors (Red Box)

- Component execution failures
- React rendering errors
- Hook usage violations

## Advanced Features

### Internationalization

Use the `t` function for translations:

```jsx
function UserComponent(props) {
  const { React, t } = props;

  return (
    <div className="p-4">
      <h1>{t('common.welcome')}</h1>
      <p>{t('component.description')}</p>
    </div>
  );
}
```

### Navigation

Use the `navigate` function for routing:

```jsx
function UserComponent(props) {
  const { React, navigate } = props;

  const handleGoHome = () => {
    navigate('/');
  };

  return (
    <button onClick={handleGoHome} className="bg-blue-500 text-white px-4 py-2 rounded">
      Go Home
    </button>
  );
}
```

### User Context

Access user information:

```jsx
function UserComponent(props) {
  const { React, user } = props;

  return (
    <div className="p-4">
      <h1>Welcome!</h1>
      <p>Your language: {user.language}</p>
    </div>
  );
}
```

## Security Considerations

### Safe Environment

- Components run in an isolated execution context
- No access to sensitive application state
- Limited to provided props and standard browser APIs

### Content Security

- All JSX code is compiled and executed client-side
- No server-side execution or file system access
- Standard browser security model applies

### Best Practices

- Validate user inputs
- Sanitize data before displaying
- Use secure HTTP requests (HTTPS)
- Avoid storing sensitive data in localStorage

## Performance Considerations

### Babel Loading

- Babel is loaded once and cached
- Multiple CDN sources ensure reliability
- Components compile quickly after initial load

### Component Execution

- Components are memoized to prevent unnecessary recompilation
- Error boundaries prevent crashes
- Optimized for real-time development

### Resource Usage

- External libraries should be loaded conditionally
- Clean up resources in useEffect cleanup functions
- Avoid memory leaks with proper event listener removal

## Migration Guide

### From Static Content

1. Create a new `.jsx` file in the pages directory
2. Convert your content to JSX format
3. Add interactive elements as needed
4. Test thoroughly in the browser

### From External Components

1. Copy your component code into the `UserComponent` structure
2. Replace imports with prop destructuring
3. Load external dependencies dynamically
4. Update styling to use Tailwind classes

This feature opens up powerful possibilities for creating interactive, dynamic content within iHub Apps while maintaining security and performance.
