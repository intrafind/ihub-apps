#!/bin/bash
# Build script for Outlook Add-in package

set -e

echo "Building Outlook Add-in package..."

# Create build directory
BUILD_DIR="outlook-package"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy manifest and HTML files
cp outlook/manifest.xml "$BUILD_DIR/"
cp outlook/taskpane.html "$BUILD_DIR/"
cp outlook/commands.html "$BUILD_DIR/"
cp -r outlook/src "$BUILD_DIR/"

# Copy assets if they exist
if [ -d "outlook/assets" ]; then
    cp -r outlook/assets "$BUILD_DIR/"
fi

# Create a placeholder for icons if they don't exist
mkdir -p "$BUILD_DIR/assets"
echo "Icon files should be placed in outlook/assets/" > "$BUILD_DIR/assets/README.txt"

# Create zip package
PACKAGE_NAME="ihub-outlook-addin.zip"
cd "$BUILD_DIR"
zip -r "../$PACKAGE_NAME" .
cd ..

echo "✅ Outlook Add-in package created: $PACKAGE_NAME"
echo "📝 To install:"
echo "   1. Configure the APP_URL in manifest.xml"
echo "   2. Upload this package to your iHub server"
echo "   3. Install in Outlook for Mac via Get Add-ins > My Add-ins > Add from File"

# Cleanup
rm -rf "$BUILD_DIR"
