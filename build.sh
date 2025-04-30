#!/bin/bash
# build.sh - Build script for AI Hub Apps
# This script now uses Node.js SEA instead of pkg

# Exit on error
set -e

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "Building AI Hub Apps v$VERSION for production..."

# Check Node.js version - SEA requires Node.js 20+
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "⚠️ Warning: Node.js version 20 or later is required for SEA builds."
  echo "Current version: $(node -v)"
  echo "Proceeding with standard build only (no binary will be created)."
  SEA_BUILD=false
else
  SEA_BUILD=true
fi

# Standard build process for development/production
echo "Building application for production..."

# Step 1: Clean previous builds
echo "Cleaning previous builds..."
rm -rf dist
mkdir -p dist/public dist/server dist/contents dist/examples

# Step 2: Build the client
echo "Building client..."
cd client
npm run build
cd ..
cp -r client/dist/* dist/public/

# Step 3: Copy server files
echo "Copying server files..."
cp -r server/*.js dist/server/
cp server/*.cjs dist/server/ # Make sure to copy the CommonJS entry point
cp -r server/adapters dist/server/
cp server/package.json dist/server/

# Step 4: Copy config files
echo "Copying configuration files..."
cp package.json dist/

# Step 5: Copy contents files
echo "Copying contents files..."
mkdir -p dist/contents
cp -r contents/* dist/contents/

# Step 6: Copy examples folder
echo "Copying examples folder..."
mkdir -p dist/examples
cp -r examples/* dist/examples/

# Step 7: Copy .env file if it exists
if [ -f .env ]; then
  echo "Copying .env file..."
  cp .env dist/
else
  echo "No .env file found, skipping..."
fi

# Step 8: Install production dependencies
echo "Installing production dependencies..."
cd dist
npm install --production
cd server
npm install --production
cd ../..

echo "Production build completed successfully!"

# Step 9: Create binary with Node.js SEA if version is compatible
if [ "$SEA_BUILD" = true ] && { [ "$1" == "--binary" ] || [ "$1" == "-b" ]; }; then
  echo "Creating binary executable using Node.js SEA..."
  ./build-sea.sh
else
  if [ "$1" == "--binary" ] || [ "$1" == "-b" ]; then
    echo "Binary creation skipped. Please use Node.js 20+ for SEA builds."
  fi
fi

echo "Build process completed!"