import { useEffect } from 'react';
import { useAppNavigatorContext } from '../shared/contexts/AppNavigatorContext';

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * Wraps AppNavigatorContext and registers the global Ctrl/Cmd+B shortcut (FR-10).
 * Ignored while the user is typing in a text field so it doesn't fight with
 * "bold text" shortcuts in rich editors.
 */
export function useAppNavigator() {
  const ctx = useAppNavigatorContext();

  useEffect(() => {
    const handleKeyDown = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        ctx.toggle();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [ctx]);

  return ctx;
}

export default useAppNavigator;
