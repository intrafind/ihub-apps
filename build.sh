#!/bin/bash
# build.sh - Build script for AI Hub Apps
# This script builds the production version and packages it as a binary using pkg

# Exit on error
set -e

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "Building AI Hub Apps v$VERSION for production..."

# Step 1: Clean previous builds
echo "Cleaning previous builds..."
rm -rf dist dist-bin
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

# Step 9: Create binary with pkg (if requested)
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
      Darwin*)  TARGET="node18-macos-x64"; OUTPUT_NAME="ai-hub-apps-macos" ;;
      Linux*)   TARGET="node18-linux-x64"; OUTPUT_NAME="ai-hub-apps-linux" ;;
      MINGW*|MSYS*|CYGWIN*)  TARGET="node18-win-x64"; OUTPUT_NAME="ai-hub-apps-win" ;;
      *)        TARGET="node18-macos-x64,node18-linux-x64,node18-win-x64"; OUTPUT_NAME="ai-hub-apps" ;;
    esac
    echo "Building for target: $TARGET"
  fi
  
  # Add version to output name
  OUTPUT_NAME="${OUTPUT_NAME}-v${VERSION}"
  echo "Output binary name: $OUTPUT_NAME"
  
  mkdir -p dist-bin
  
  # Run pkg - using the CommonJS entry point
  npx pkg . --target $TARGET --output dist-bin/$OUTPUT_NAME --options max_old_space_size=4096
  
  # Copy necessary directories to the binary distribution
  echo "Copying assets for binary..."
  mkdir -p dist-bin/public
  cp -r dist/public/* dist-bin/public/
  
  # Copy contents directory 
  echo "Copying contents directory..."
  mkdir -p dist-bin/contents
  cp -r dist/contents/* dist-bin/contents/
  
  # Copy examples directory
  echo "Copying examples directory..."
  mkdir -p dist-bin/examples
  cp -r dist/examples/* dist-bin/examples/
  
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