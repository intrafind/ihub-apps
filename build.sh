#!/bin/bash
# build.sh - Build script for AI Hub Apps
# This script builds the production version and packages it as a binary using pkg

# Exit on error
set -e

# Print what we're doing
echo "Building AI Hub Apps for production..."

# Step 1: Clean previous builds
echo "Cleaning previous builds..."
rm -rf dist dist-bin
mkdir -p dist/public dist/server dist/config

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
cp -r config/* dist/config/
cp package.json dist/

# Step 5: Copy contents files
echo "Copying contents files..."
mkdir -p dist/contents/sources dist/contents/pages
cp -r contents/* dist/contents/

# Ensure the pages directory exists in the output
mkdir -p dist/contents/pages/en dist/contents/pages/de
mkdir -p dist/contents/sources

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
npm install --production
cd server
npm install --production
cd ../..

echo "Production build completed successfully!"

# Step 8: Create binary with pkg (if requested)
if [ "$1" == "--binary" ] || [ "$1" == "-b" ]; then
  echo "Creating binary executable..."
  
  # Determine target based on OS
  TARGET=""
  if [ "$2" == "--all" ] || [ "$2" == "-a" ]; then
    TARGET="node18-macos-x64,node18-linux-x64,node18-win-x64"
    OUTPUT_NAME="ai-hub-apps"
    echo "Building for all platforms"
  else
    case "$(uname -s)" in
      Darwin*)  TARGET="node18-macos-x64"; OUTPUT_NAME="ai-hub-apps-darwin" ;;
      Linux*)   TARGET="node18-linux-x64"; OUTPUT_NAME="ai-hub-apps-linux" ;;
      MINGW*|MSYS*|CYGWIN*)  TARGET="node18-win-x64"; OUTPUT_NAME="ai-hub-apps-win" ;;
      *)        TARGET="node18-macos-x64,node18-linux-x64,node18-win-x64"; OUTPUT_NAME="ai-hub-apps" ;;
    esac
    echo "Building for target: $TARGET"
  fi
  
  mkdir -p dist-bin
  
  # Run pkg - using the CommonJS entry point
  npx pkg . --target $TARGET --output dist-bin/$OUTPUT_NAME --options max_old_space_size=4096
  
  # Copy public and config folders next to the binary
  echo "Copying assets for binary..."
  mkdir -p dist-bin/public dist-bin/config dist-bin/contents/pages/en dist-bin/contents/pages/de dist-bin/contents/sources
  cp -r dist/public/* dist-bin/public/
  cp -r dist/config/* dist-bin/config/
  
  # Copy contents directory if it exists
  if [ -d "dist/contents" ]; then
    echo "Copying contents directory..."
    cp -r dist/contents/* dist-bin/contents/
  fi
  
  # Copy configuration template
  echo "Copying configuration template..."
  cp config.env dist-bin/
  
  # Copy .env file if it exists
  if [ -f .env ]; then
    echo "Copying .env file to binary assets..."
    cp .env dist-bin/
  fi
  
  echo "Binary creation completed successfully!"
  echo "Your binary is available at: dist-bin/$OUTPUT_NAME"
fi

echo "Build process completed!"