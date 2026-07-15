import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const STORAGE_KEY_COLLAPSED_CATEGORIES = 'app-navigator-collapsed-categories';

const AppNavigatorContext = createContext(null);

export function AppNavigatorProvider({ children }) {
  // FR-12: open/closed state is intentionally NOT persisted — always starts closed.
  const [isOpen, setIsOpen] = useState(false);

  const [collapsedCategories, setCollapsedCategories] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_COLLAPSED_CATEGORIES);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY_COLLAPSED_CATEGORIES,
        JSON.stringify([...collapsedCategories])
      );
    } catch {
      // ignore storage errors
    }
  }, [collapsedCategories]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen(prev => !prev), []);

  const toggleCategory = useCallback(categoryId => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  }, []);

  const isCategoryCollapsed = useCallback(
    categoryId => collapsedCategories.has(categoryId),
    [collapsedCategories]
  );

  return (
    <AppNavigatorContext.Provider
      value={{ isOpen, open, close, toggle, toggleCategory, isCategoryCollapsed }}
    >
      {children}
    </AppNavigatorContext.Provider>
  );
}

export function useAppNavigatorContext() {
  const ctx = useContext(AppNavigatorContext);
  if (!ctx) {
    throw new Error('useAppNavigatorContext must be used within an AppNavigatorProvider');
  }
  return ctx;
}

export default AppNavigatorContext;
