export function debugLog(...args) {
  if (import.meta.env.DEV) {
    console.log(...args);
  }
}
