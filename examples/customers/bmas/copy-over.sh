#!/bin/bash

# Script to copy content from copy-over folder to kipitz folder
# This will overlay/replace existing files but keep other files intact

SOURCE_DIR="kipitz/examples/customers/bmas"
DEST_DIR="kipitz"

# Check if source directory exists
if [ ! -d "$SOURCE_DIR" ]; then
    echo "Error: Source directory '$SOURCE_DIR' does not exist."
    exit 1
fi

# Check if destination directory exists
if [ ! -d "$DEST_DIR" ]; then
    echo "Error: Destination directory '$DEST_DIR' does not exist."
    exit 1
fi

# Copy files from source to destination, preserving directory structure
# and replacing existing files while keeping others
echo "Copying files from '$SOURCE_DIR' to '$DEST_DIR'..."
echo "This will replace existing files but keep other files intact."

# Use rsync for better control over the copy operation
if command -v rsync &> /dev/null; then
    rsync -av "$SOURCE_DIR"/. "$DEST_DIR"/
    COPY_RESULT=$?
else
    # Fallback to cp if rsync is not available
    cp -rf "$SOURCE_DIR"/. "$DEST_DIR"/
    COPY_RESULT=$?
fi

# Check if copy was successful
if [ $COPY_RESULT -eq 0 ]; then
    echo "Files copied successfully from '$SOURCE_DIR' to '$DEST_DIR'."
    echo "Existing files were replaced, other files were preserved."
else
    echo "Error: Failed to copy files."
    exit 1
fi

echo "Script completed."
