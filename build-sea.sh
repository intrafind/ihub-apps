#!/bin/bash

# build-sea.sh - Build script for iHub Apps using Node.js Single Executable Application (SEA) 
# Requires Node.js 20 or later

set -e  # Exit on errors

# Check Node.js version
scripts/check-node-version.sh

# Check if platform argument was provided
if [ -n "$1" ]; then
  PLATFORM="--platform=$1"
  echo "Building for platform: $1"
else
  PLATFORM=""
  echo "Building for current platform"
fi

# Display build information
echo "Building iHub Apps using Node.js SEA..."
echo "Node.js version: $(node -v)"
echo "OS platform: $(uname -s)"

# Build documentation before packaging
echo "Building documentation..."
npm run docs:build:all

# Run the SEA build script with .cjs extension
node build-sea.cjs $PLATFORM

echo "Build complete! Executables are in the dist-bin directory."
