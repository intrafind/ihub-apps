#!/bin/bash

# build-sea.sh - Build script for AI Hub Apps using Node.js Single Executable Application (SEA) 
# Requires Node.js 20 or later

set -e  # Exit on errors

# Check Node.js version
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "Error: Node.js version 20 or later is required for SEA. Current version: $(node -v)"
  exit 1
fi

# Check if platform argument was provided
if [ -n "$1" ]; then
  PLATFORM="--platform=$1"
  echo "Building for platform: $1"
else
  PLATFORM=""
  echo "Building for current platform"
fi

# Display build information
echo "Building AI Hub Apps using Node.js SEA..."
echo "Node.js version: $(node -v)"
echo "OS platform: $(uname -s)"

# Run the SEA build script with .cjs extension
node build-sea.cjs $PLATFORM

echo "Build complete! Executables are in the dist-bin directory."