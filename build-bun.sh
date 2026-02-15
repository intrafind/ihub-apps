#!/bin/bash

# build-bun.sh - Build script for iHub Apps using Bun's built-in compiler
# Bun 1.3.0 or later required

set -e  # Exit on errors

# Check if Bun is installed
if ! command -v bun &> /dev/null; then
    echo "❌ Bun is not installed. Please install Bun first:"
    echo "   curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Display build information
echo "Building iHub Apps using Bun compile..."
echo "Bun version: $(bun --version)"
echo "OS platform: $(uname -s)"

# Parse platform argument
PLATFORM=""
if [ -n "$1" ]; then
  PLATFORM="$1"
  echo "Building for platform: $PLATFORM"
else
  echo "Building for current platform"
fi

# Build documentation before packaging
echo "Building documentation..."
bun run docs:build:all

# Create dist-bin directory
mkdir -p dist-bin

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "Version: v$VERSION"

# Determine target based on platform argument
case "$PLATFORM" in
  "linux")
    TARGET="bun-linux-x64"
    OUTPUT_NAME="ihub-apps-v$VERSION-linux"
    ;;
  "macos")
    # Detect architecture
    ARCH=$(uname -m)
    if [ "$ARCH" = "arm64" ]; then
      TARGET="bun-darwin-arm64"
      OUTPUT_NAME="ihub-apps-v$VERSION-macos-arm"
    else
      TARGET="bun-darwin-x64"
      OUTPUT_NAME="ihub-apps-v$VERSION-macos-intel"
    fi
    ;;
  "win")
    TARGET="bun-windows-x64"
    OUTPUT_NAME="ihub-apps-v$VERSION-win.exe"
    ;;
  *)
    # No platform specified, use current platform
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
      TARGET="bun-linux-x64"
      OUTPUT_NAME="ihub-apps-v$VERSION-linux"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
      ARCH=$(uname -m)
      if [ "$ARCH" = "arm64" ]; then
        TARGET="bun-darwin-arm64"
        OUTPUT_NAME="ihub-apps-v$VERSION-macos-arm"
      else
        TARGET="bun-darwin-x64"
        OUTPUT_NAME="ihub-apps-v$VERSION-macos-intel"
      fi
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
      TARGET="bun-windows-x64"
      OUTPUT_NAME="ihub-apps-v$VERSION-win.exe"
    else
      echo "❌ Unsupported platform: $OSTYPE"
      exit 1
    fi
    ;;
esac

echo "Target: $TARGET"
echo "Output: $OUTPUT_NAME"

# Bundle and compile server with Bun
echo "Compiling server..."
bun build server/server.js \
  --compile \
  --target="$TARGET" \
  --outfile="dist-bin/$OUTPUT_NAME" \
  --minify \
  --sourcemap=external

# Check if build was successful
if [ -f "dist-bin/$OUTPUT_NAME" ]; then
  echo "✅ Build complete!"
  echo "📦 Executable: dist-bin/$OUTPUT_NAME"
  
  # Display file size
  if command -v du &> /dev/null; then
    SIZE=$(du -h "dist-bin/$OUTPUT_NAME" | cut -f1)
    echo "📊 Size: $SIZE"
  fi
  
  # Make executable on Unix-like systems
  if [[ "$OSTYPE" != "msys" ]] && [[ "$OSTYPE" != "win32" ]]; then
    chmod +x "dist-bin/$OUTPUT_NAME"
    echo "✅ Made executable"
  fi
else
  echo "❌ Build failed!"
  exit 1
fi

echo ""
echo "Build complete! Executable is in dist-bin/$OUTPUT_NAME"
