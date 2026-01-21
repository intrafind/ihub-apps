---
applyTo: "client/src/**/*.{jsx,tsx}"
---

# React Component Guidelines for iHub Apps

When working with React components in this project, follow these specific guidelines:

## Component Structure

1. **Functional Components** - Use functional components with hooks, not class components
2. **Named Exports** - Export components using named exports for better tree-shaking
3. **PropTypes/TypeScript** - While not strictly enforced, add prop documentation in comments
4. **Component Files** - One component per file, matching the filename (PascalCase)

## Hooks Usage

1. **Standard Hooks** - Prefer React's built-in hooks (`useState`, `useEffect`, `useMemo`, `useCallback`)
2. **Custom Hooks** - Extract reusable logic into custom hooks prefixed with `use`
3. **Hook Dependencies** - Always include all dependencies in hook dependency arrays
4. **Cleanup** - Return cleanup functions from `useEffect` when needed (event listeners, subscriptions)

## Context API

1. **Existing Contexts** - Use these existing contexts when needed:
   - `AuthContext` - User authentication and permissions
   - `PlatformConfigContext` - Server configuration and feature flags
   - `UIConfigContext` - UI customization and localization
2. **Context Providers** - Don't create new contexts without discussion
3. **Context Consumption** - Use `useContext` hook for consuming context values

## Styling

1. **Tailwind CSS** - Use Tailwind utility classes for all styling
2. **Dark Mode** - Support both light and dark modes using Tailwind's dark mode classes
3. **Responsive Design** - Use Tailwind's responsive prefixes (`sm:`, `md:`, `lg:`, `xl:`)
4. **No Inline Styles** - Avoid inline styles unless absolutely necessary
5. **Custom CSS** - Avoid custom CSS files; use Tailwind's configuration if needed

## Internationalization (i18n)

1. **Translation Hook** - Use the `t()` function from i18n context for all user-facing text
2. **Translation Keys** - Use descriptive dot-notation keys (e.g., `app.chat.sendMessage`)
3. **Update Translation Files** - Add new keys to both `shared/i18n/en.json` and `shared/i18n/de.json`
4. **Never Hardcode Text** - All user-facing strings must be translatable

## State Management

1. **Local State** - Use `useState` for component-local state
2. **Lifted State** - Lift state to parent components when needed by multiple children
3. **Global State** - Use Context API for truly global state
4. **Avoid Prop Drilling** - Use Context or composition patterns to avoid deep prop drilling

## Performance

1. **Memoization** - Use `useMemo` for expensive computations
2. **Callback Memoization** - Use `useCallback` for callbacks passed to optimized child components
3. **React.memo** - Wrap components with `React.memo` when appropriate (frequent re-renders with same props)
4. **Lazy Loading** - Use `React.lazy` and `Suspense` for code splitting large components

## API Integration

1. **API Client** - Use the centralized API client in `client/src/api/`
2. **Error Handling** - Always handle API errors gracefully with user-friendly messages
3. **Loading States** - Show loading indicators during API calls
4. **Caching** - Leverage existing API caching mechanisms

## Routing

1. **React Router** - Use React Router v6 for navigation
2. **Protected Routes** - Use `ProtectedRoute` component for authenticated routes
3. **Navigation** - Use `useNavigate` hook for programmatic navigation
4. **Route Parameters** - Use `useParams` for accessing route parameters

## Event Handling

1. **Arrow Functions** - Use arrow functions or `useCallback` for event handlers
2. **Event Naming** - Prefix handler functions with `handle` (e.g., `handleClick`, `handleSubmit`)
3. **Prevent Default** - Remember to call `e.preventDefault()` for form submissions

## Forms

1. **Controlled Components** - Use controlled components for form inputs
2. **Form Libraries** - Use existing form patterns in the codebase
3. **Validation** - Validate user input both client-side and server-side
4. **Accessibility** - Include proper labels and ARIA attributes for form elements

## Common Patterns to Follow

```jsx
// Good: Functional component with hooks and internationalization
import { useState, useEffect, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '@/shared/contexts/AuthContext';

export function MyComponent({ initialValue }) {
  const { t } = useTranslation();
  const { user } = useContext(AuthContext);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    // Effect logic with cleanup
    return () => {
      // Cleanup
    };
  }, []);

  const handleChange = (e) => {
    setValue(e.target.value);
  };

  return (
    <div className="p-4 bg-white dark:bg-gray-800">
      <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
        {t('myComponent.title')}
      </h2>
      <input
        type="text"
        value={value}
        onChange={handleChange}
        className="mt-2 p-2 border rounded"
      />
    </div>
  );
}
```

## What NOT to Do

❌ **Don't:**
- Create class components
- Use inline styles instead of Tailwind
- Hardcode user-facing text (always use i18n)
- Mutate state directly
- Create side effects outside `useEffect`
- Forget to handle loading and error states
- Modify existing component layouts without explicit instruction

✅ **Do:**
- Use functional components with hooks
- Apply Tailwind CSS classes
- Internationalize all user-facing text
- Handle errors gracefully
- Show loading states
- Follow existing component patterns
- Maintain responsive design
