import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';

const STORAGE_KEY_COLLAPSED = 'admin-sidebar-collapsed';
const STORAGE_KEY_SECTIONS = 'admin-sidebar-sections';

const SidebarContext = createContext(null);

export function SidebarProvider({ children, sectionIds = [] }) {
  const location = useLocation();

  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_COLLAPSED) === 'true';
    } catch {
      return false;
    }
  });

  const [expandedSections, setExpandedSections] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_SECTIONS);
      return stored ? new Set(JSON.parse(stored)) : new Set(sectionIds);
    } catch {
      return new Set(sectionIds);
    }
  });

  const [isMobileOpen, setIsMobileOpen] = useState(false);

  // Persist collapsed state
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, String(isCollapsed));
    } catch {
      // ignore storage errors
    }
  }, [isCollapsed]);

  // Persist expanded sections
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_SECTIONS, JSON.stringify([...expandedSections]));
    } catch {
      // ignore storage errors
    }
  }, [expandedSections]);

  // Close mobile drawer on navigation
  useEffect(() => {
    setIsMobileOpen(false);
  }, [location.pathname]);

  const toggle = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  const toggleSection = useCallback(sectionId => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  const expandSection = useCallback(sectionId => {
    setExpandedSections(prev => {
      if (prev.has(sectionId)) return prev;
      return new Set([...prev, sectionId]);
    });
  }, []);

  const openMobile = useCallback(() => setIsMobileOpen(true), []);
  const closeMobile = useCallback(() => setIsMobileOpen(false), []);

  return (
    <SidebarContext.Provider
      value={{
        isCollapsed,
        expandedSections,
        isMobileOpen,
        toggle,
        toggleSection,
        expandSection,
        openMobile,
        closeMobile
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return ctx;
}
