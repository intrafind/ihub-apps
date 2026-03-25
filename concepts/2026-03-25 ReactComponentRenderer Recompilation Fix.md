# ReactComponentRenderer Recompilation Fix

## Problem

`ReactComponentRenderer` recompiled JSX whenever `componentProps` changed identity, even if
`jsxCode` stayed the same. In practice, parents often pass `componentProps` as inline object
literals, so ordinary parent re-renders triggered a full Babel transform, wrapper recreation,
and visible loading flicker.

## Decision

Keep JSX compilation tied only to `jsxCode` changes and explicit recompilation resets.
Inject `componentProps` into the compiled wrapper at render time instead of closing over them
during compilation.

## Implementation

- `client/src/shared/components/ReactComponentRenderer.jsx`
  - Remove `componentProps` from the compilation effect dependencies
  - Keep a stable compiled wrapper component in state
  - Pass the latest `componentProps` into that wrapper during render
  - Add an explicit `compileVersion` reset path so the error boundary can force recompilation

## Verification

- Reproduced locally before the fix with a direct jsdom-based harness:
  - initial Babel transforms: `1`
  - after parent re-render with unchanged `jsxCode`: `2`
- Verified locally after the fix with the same harness:
  - initial Babel transforms: `1`
  - after parent re-render with unchanged `jsxCode`: `1`
- A Jest regression test was attempted but not kept in the patch because the current repo test
  environment mixes React versions between the root toolchain and the client package, which makes
  this component path unreliable under Jest.

## Expected Outcome

- Parent re-renders no longer cause redundant JSX recompilation
- `componentProps` updates still flow into the rendered component
- Error boundary resets continue to trigger a fresh compilation when requested
