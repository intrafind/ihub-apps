# EPUB Build Fix

**Date:** 2025-12-04  
**Status:** ✅ Completed  
**Related Files:**
- `docs/book-epub.toml`
- `package.json` (docs:build:epub script)
- `.github/workflows/build-binaries.yml`
- `.github/workflows/mdbook.yml`

## Problem

The release build was failing during the documentation build step with the following error:

```
> ihub-apps@4.3.11 docs:build:epub
> cd docs && mkdir -p book/epub && cp book.toml book.toml.bak && cp book-epub.toml book.toml && mdbook build && mv book.toml.bak book.toml

INFO Book building has started
INFO Running the epub backend
INFO Invoking the "epub" renderer
Running mdbook-epub as plugin waiting on the STDIN input. If you wanted to process the files in the current folder, use the -s flag from documentation, See: mdbook-epub --help
[2025-12-04T17:32:40Z ERROR mdbook_epub] Unable to parse render context
ERROR Renderer exited with non-zero return code.
ERROR Rendering failed
	Caused by: The "epub" renderer failed
Error: Process completed with exit code 101.
```

## Root Cause

The `output-file` parameter in `docs/book-epub.toml` was incorrectly configured with an absolute path including the build directory prefix:

```toml
output-file = "book/epub/iHub-Apps-Documentation.epub"
```

This caused `mdbook-epub` to fail when parsing the render context passed via STDIN from the main `mdbook` process.

## Solution

### Changes Made

1. **Modified `docs/book-epub.toml`:**
   - Added `build-dir = "book/epub"` to the `[build]` section
   - Changed `output-file` from `book/epub/iHub-Apps-Documentation.epub` to `iHub-Apps-Documentation.epub`

### Technical Details

**Before:**
```toml
[build]
create-missing = false

[output.epub]
# ... other settings ...
output-file = "book/epub/iHub-Apps-Documentation.epub"
```

**After:**
```toml
[build]
create-missing = false
build-dir = "book/epub"

[output.epub]
# ... other settings ...
output-file = "iHub-Apps-Documentation.epub"
```

### How It Works

1. The `build-dir` parameter tells mdbook to place all build output in `book/epub/` directory
2. The `output-file` parameter is now relative to the build directory, not an absolute path
3. The final epub file is created at `docs/book/epub/iHub-Apps-Documentation.epub`
4. This matches what the `docs:copy:all` script expects when copying files to `dist/exports/`

## Build Process

The epub build follows this flow:

```bash
# From package.json docs:build:epub script
cd docs && \
  mkdir -p book/epub && \
  cp book.toml book.toml.bak && \
  cp book-epub.toml book.toml && \
  mdbook build && \
  mv book.toml.bak book.toml
```

1. Create the `book/epub` directory
2. Backup the original `book.toml`
3. Replace `book.toml` with `book-epub.toml` (epub-specific configuration)
4. Run `mdbook build` (which invokes mdbook-epub as a renderer)
5. Restore the original `book.toml`

## Verification

The fix ensures:
- ✅ `mdbook-epub` receives proper render context via STDIN
- ✅ EPUB file is created in the correct location: `docs/book/epub/iHub-Apps-Documentation.epub`
- ✅ The `docs:copy:all` script can find and copy the epub to `dist/exports/`
- ✅ GitHub Actions workflow successfully builds and releases the documentation

## Related Documentation

- [mdbook-epub documentation](https://github.com/Michael-F-Bryan/mdbook-epub)
- [mdbook configuration](https://rust-lang.github.io/mdBook/format/configuration/index.html)
- Issue: Release build failed in "building using node.js sea" (EPUB build error)

## Future Considerations

- Consider pinning specific versions of `mdbook` and `mdbook-epub` in CI/CD to avoid breaking changes
- Add a local test script to verify documentation builds before pushing to CI
- Document the epub build process in the main documentation
