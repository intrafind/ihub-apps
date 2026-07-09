# EPUB Build Fix (Updated)

**Date:** 2025-12-04 (Updated)  
**Status:** ✅ Completed  
**Related Files:**
- `docs/book-epub.toml`
- `package.json` (docs:build:epub script)
- `.github/workflows/build-binaries.yml`
- `.github/workflows/mdbook.yml`

## Problem

The EPUB build continued to fail even after the initial fix, with the error:

```
Running mdbook-epub as plugin waiting on the STDIN input. If you wanted to process the files in the current folder, use the -s flag from documentation, See: mdbook-epub --help
[2025-12-04T17:59:02Z ERROR mdbook_epub] Unable to parse render context
ERROR Renderer exited with non-zero return code.
```

## Root Cause

The issue was that `mdbook-epub` was being invoked as a **backend renderer** by `mdbook build`, but the configuration with `build-dir = "book/epub"` was preventing proper communication between mdbook and the epub backend via STDIN.

When mdbook invokes a backend renderer, it passes a `RenderContext` JSON object via STDIN. However, with the custom build directory configuration, this communication was breaking, causing the "Unable to parse render context" error.

## Solution

### Changes Made

1. **Modified `package.json` script:**
   - Changed from using `mdbook build` (which invokes epub as a backend)
   - To using `mdbook-epub --standalone .` (which runs epub in standalone mode)

2. **Modified `docs/book-epub.toml`:**
   - Changed `build-dir` from `"book/epub"` to `"book"`
   - Removed `output-file` parameter (not needed in standalone mode)

### Technical Details

**Package.json Before:**
```json
"docs:build:epub": "cd docs && mkdir -p book/epub && cp book.toml book.toml.bak && cp book-epub.toml book.toml && mdbook build && mv book.toml.bak book.toml"
```

**Package.json After:**
```json
"docs:build:epub": "cd docs && cp book.toml book.toml.bak && cp book-epub.toml book.toml && mdbook-epub --standalone . && mv book.toml.bak book.toml"
```

**book-epub.toml Before:**
```toml
[build]
create-missing = false
build-dir = "book/epub"

[output.epub]
output-file = "iHub-Apps-Documentation.epub"
```

**book-epub.toml After:**
```toml
[build]
create-missing = false
build-dir = "book"

[output.epub]
# output-file removed - mdbook-epub in standalone mode handles this automatically
```

### How It Works

1. **Standalone Mode**: The `-s` or `--standalone` flag tells mdbook-epub to run independently without being invoked by mdbook
2. **Direct Configuration**: In standalone mode, mdbook-epub reads the book.toml configuration directly and processes the markdown files itself
3. **Output Location**: With `build-dir = "book"`, mdbook-epub automatically outputs to `book/epub/` (it appends "epub" to the build directory)
4. **File Naming**: The epub file is automatically named after the book title: `iHub-Apps-Documentation.epub`

## Build Process

The epub build now follows this simplified flow:

```bash
# From package.json docs:build:epub script
cd docs && \
  cp book.toml book.toml.bak && \
  cp book-epub.toml book.toml && \
  mdbook-epub --standalone . && \
  mv book.toml.bak book.toml
```

1. Backup the original `book.toml`
2. Replace `book.toml` with `book-epub.toml` (epub-specific configuration)
3. Run `mdbook-epub --standalone .` (standalone mode processing)
4. Restore the original `book.toml`

## Verification

The fix ensures:
- ✅ `mdbook-epub` runs in standalone mode, avoiding STDIN communication issues
- ✅ EPUB file is created in the correct location: `docs/book/epub/iHub-Apps-Documentation.epub`
- ✅ The `docs:copy:all` script can find and copy the epub to `dist/exports/`
- ✅ GitHub Actions workflow successfully builds and releases the documentation
- ✅ No `mkdir -p book/epub` needed - mdbook-epub creates the directory automatically

## Why Standalone Mode?

The standalone mode was chosen because:
1. **Simpler**: Avoids complex STDIN/STDOUT communication between processes
2. **More Reliable**: Direct configuration reading eliminates parsing issues
3. **Clearer Intent**: Explicitly shows we're building epub separately from HTML output
4. **Better Error Messages**: Errors are more straightforward to debug

## Related Documentation

- [mdbook-epub documentation](https://github.com/Michael-F-Bryan/mdbook-epub)
- [mdbook configuration](https://rust-lang.github.io/mdBook/format/configuration/index.html)
- Issue: epub build still failing (follow-up to initial fix)

## Future Considerations

- Consider using environment variable `RUST_LOG=debug` for verbose output during troubleshooting
- Pin specific version of mdbook-epub if stability issues arise with updates
- Document the standalone mode approach for other backend renderers if needed
