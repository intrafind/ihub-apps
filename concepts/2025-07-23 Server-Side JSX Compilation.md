# Server-Side JSX Compilation

## Overview

The current platform compiles dynamic React components in the browser with Babel Standalone. While convenient, every user must pay the compilation cost. To improve performance and allow CDN caching, JSX should be compiled on the server.

Dynamic pages are created at runtime and can change at any moment, so we cannot precompile them during the build. Instead, the server will compile components at startup and whenever a page is updated, producing static JavaScript bundles that are cacheable by a CDN.

## Goals

- Remove client-side Babel usage.
- Deliver precompiled bundles via CDN with long-term caching.
- Automatically recompile pages on creation or change.
- Ensure users always receive the latest bundle when content updates.

## Design

### Compilation Pipeline

1. On server startup, scan `contents/pages/{lang}` for `.jsx` files.
2. Use `@babel/core` with the React preset (or `esbuild`) to transform each page to JavaScript.
3. Generate a content hash for the compiled output.
4. Write the bundle to `public/pages/{slug}.{hash}.js`.
5. Store a mapping from page slug to hashed bundle name in memory or on disk.

### Runtime Updates

- The page editor triggers recompilation when a page is created or saved.
- A `chokidar` watcher handles hot reloading in development.
- When a page changes, the server writes a new hashed file and updates the mapping so old bundles are no longer referenced.

### Serving Compiled Components

- The page response includes a `<script>` tag referencing the hashed bundle.
- CDN caching uses `Cache-Control: public, max-age=31536000, immutable` because the filename contains the content hash.
- Any content change results in a new filename, automatically busting caches.

### Invalidation and Cleanup

- Track the hashes in use and periodically remove obsolete files.
- Persist the mapping so restarts do not require full recompilation unless files have changed.

## Benefits

- Users avoid client-side compilation overhead.
- CDN caching improves load times and reduces server load.
- Dynamic pages remain fully editable because the server recompiles them whenever necessary.
