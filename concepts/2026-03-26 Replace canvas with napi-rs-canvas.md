# Replace `canvas` with `@napi-rs/canvas`

**Date:** 2026-03-26  
**Issue:** Dependencies can't be installed in build and releases binaries step  
**Status:** Implemented

## Problem

The `canvas` npm package (node-canvas v2.x) is a native addon that requires system-level libraries
(`pixman-1`, `cairo`, `pango`, etc.) and build tools (`python3`, `make`, `g++`) to compile via `node-gyp`.

On GitHub Actions runners (ubuntu-latest, macos-latest, windows-latest), these system libraries are not
pre-installed, causing `npm ci` to fail during the build-binaries workflow with errors like:

```
Package pixman-1 was not found in the pkg-config search path.
gyp ERR! configure error
```

## Solution

Replaced `canvas` with `@napi-rs/canvas` — a high-performance, Rust-based Canvas implementation that
ships **prebuilt binaries** for all major platforms (Linux, macOS, Windows, both x64 and ARM).

### Why `@napi-rs/canvas`?

- **No native compilation required** — prebuilt binaries eliminate the need for system-level build tools
- **Cross-platform** — works on all CI environments without platform-specific dependency installation
- **Compatible API** — provides the same Canvas 2D API used by `pdfjs-dist` for PDF rendering
- **Actively maintained** — modern Skia-backed implementation with regular updates

### API Differences

| Feature | `canvas` (node-canvas) | `@napi-rs/canvas` |
|---------|----------------------|-------------------|
| Import | `from 'canvas'` | `from '@napi-rs/canvas'` |
| JPEG quality scale | 0–1 (float) | 0–100 (integer) |
| `toBuffer` quality | `toBuffer('image/jpeg', { quality: 0.85 })` | `toBuffer('image/jpeg', 85)` |

## Files Changed

- `server/package.json` — replaced `canvas` with `@napi-rs/canvas`
- `server/routes/toolsService/processors/ocrProcessor.js` — updated import and `toBuffer` quality parameter
- `server/package-lock.json` — regenerated automatically

## Impact

- **CI/CD:** Build-binaries workflow will no longer fail due to missing system libraries
- **Docker:** Dockerfile Stage 1 still installs `python3`, `make`, `g++` for other potential native addons
- **OCR functionality:** PDF-to-image rendering for OCR should work identically
