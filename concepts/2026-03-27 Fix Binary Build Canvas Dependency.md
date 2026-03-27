# Fix Binary Build - Canvas Dependency Failure

**Date:** 2026-03-27
**Issue:** Binaries still can't be built (#1137)

## Problem

The `canvas` npm package (v2.11.2) is a native Node.js module that requires system libraries (cairo, pango, pixman, etc.) to compile from source. The GitHub Actions build was failing because:

1. **No pre-built binaries for Node.js 24** - `canvas@2.11.2` does not ship pre-built binaries for Node.js v24 (ABI v137), so `node-pre-gyp` returns a 404 error.
2. **Missing system libraries** - When falling back to source compilation, the required system libraries (`pixman-1`, `cairo`, `pango`) were not installed on the CI runner, causing `gyp` to fail.

## Solution

A two-part approach was implemented:

### 1. Make `canvas` an optional dependency

- Moved `canvas` from `dependencies` to `optionalDependencies` in `server/package.json`
- `npm ci` / `npm install` will attempt to install `canvas` but won't fail the entire install if it can't
- Modified `ocrProcessor.js` to use lazy dynamic import (`await import('canvas')`) with a try-catch instead of a static top-level import
- The server starts and operates normally even without `canvas` — only the OCR tool feature requires it

### 2. Install system libraries where canvas is needed

- **CI workflow** (`build-binaries.yml`): Added steps to install canvas build dependencies on Ubuntu (`libcairo2-dev`, `libpango1.0-dev`, `libjpeg-dev`, `libgif-dev`, `librsvg2-dev`) and macOS (`cairo`, `pango`, `libpng`, `jpeg`, `giflib`, `librsvg`, `pixman`)
- **Dockerfile**: Added canvas build libraries to Stage 1 (dependencies) and runtime libraries to Stage 4 (production)
- Windows builds rely on the optional dependency mechanism — canvas gracefully degrades

## Files Changed

- `server/package.json` — moved `canvas` to `optionalDependencies`
- `server/routes/toolsService/processors/ocrProcessor.js` — lazy dynamic import for canvas
- `.github/workflows/build-binaries.yml` — install canvas system deps in CI
- `docker/Dockerfile` — install canvas system deps in build and runtime stages

## Impact

- **No breaking changes** — canvas functionality (OCR tool) works exactly as before when system libraries are available
- **Graceful degradation** — server starts successfully even without canvas; OCR operations return a clear error message if canvas is missing
- **CI builds succeed** — both build-check (ubuntu) and full builds (ubuntu, macOS, windows) complete successfully
