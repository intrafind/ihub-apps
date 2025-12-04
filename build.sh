#!/bin/bash
# build.sh - Build script for iHub Apps
# This script now uses Node.js SEA instead of pkg

# Exit on error
set -e

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "Building iHub Apps v$VERSION for production..."

# Check Node.js version - SEA requires Node.js 20+
if scripts/check-node-version.sh; then
  SEA_BUILD=true
else
  echo "⚠️ Warning: Node.js version 20 or later is required for SEA builds."
  echo "Proceeding with standard build only (no binary will be created)."
  SEA_BUILD=false
fi

# Standard build process for development/production
echo "Building application for production..."

# Step 1: Clean previous builds
echo "Cleaning previous builds..."
rm -rf dist
mkdir -p dist/public dist/server

# Step 2: Build the client
echo "Building client..."
cd client
npm run build
cd ..
cp -r client/dist/* dist/public/

# Step 3: Build documentation
echo "Building documentation..."
npm run docs:build:all

# Copy generated docs into dist
mkdir -p dist/public/help dist/exports
cp -r docs/book/html/* dist/public/help/ 2>/dev/null || true
cp docs/book/epub/*.epub dist/exports/ 2>/dev/null || true
cp docs/book/iHub-Apps-Documentation.md dist/exports/ 2>/dev/null || true

# Step 4: Copy server files
echo "Copying server files..."
cp -r server/*.js dist/server/
cp server/*.cjs dist/server/ # Make sure to copy the CommonJS entry point
cp -r server/adapters dist/server/
cp server/package.json dist/server/

# Step 4.5: Copy shared directory
echo "Copying shared files..."
mkdir -p dist/shared
cp -r shared/* dist/shared/

# Step 5: Copy config files
echo "Copying configuration files..."
cp package.json dist/

# Create version file for binary builds
echo "$VERSION" > dist/version.txt

# Step 6: Copy .env file if it exists
if [ -f .env ]; then
  echo "Copying .env file..."
  cp .env dist/
else
  echo "No .env file found, skipping..."
fi

# Step 7: Install production dependencies
echo "Installing production dependencies..."
cd dist
npm ci --omit=dev
cd server
npm ci --omit=dev
cd ../..

echo "Production build completed successfully!"

# Step 8: Create binary with Node.js SEA if version is compatible
if [ "$SEA_BUILD" = true ] && { [ "$1" == "--binary" ] || [ "$1" == "-b" ]; }; then
  echo "Creating binary executable using Node.js SEA..."
  ./build-sea.sh
else
  if [ "$1" == "--binary" ] || [ "$1" == "-b" ]; then
    echo "Binary creation skipped. Please use Node.js 20+ for SEA builds."
  fi
fi

echo "Build process completed!"
