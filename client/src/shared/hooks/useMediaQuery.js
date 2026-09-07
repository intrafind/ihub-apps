import { useEffect, useState } from 'react';

/**
 * Track a CSS media query from React so components can render exactly one
 * variant (e.g. desktop sidebar vs. mobile drawer) instead of mounting both
 * and hiding one with CSS. Returns false where matchMedia is unavailable
 * (tests, SSR).
 */
export default function useMediaQuery(query) {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [matches, setMatches] = useState(() =>
    supported ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    if (!supported) return undefined;
    const mql = window.matchMedia(query);
    const onChange = event => setMatches(event.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query, supported]);

  return matches;
}
