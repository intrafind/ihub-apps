#!/bin/bash

# A script to recursively find and concatenate files in a directory.
# Each file's content is prepended with metadata (filename, relative path)
# and separated by a blank line.

set -euo pipefail # Exit on error, undefined variable, or pipe failure

# --- Usage function ---
usage() {
  echo "Usage: $0 [OPTIONS] <source_directory> <output_file> [extension1 extension2 ...]"
  echo
  echo "Arguments:"
  echo "  <source_directory>    The directory to search for files recursively."
  echo "  <output_file>         The file to write the concatenated content to."
  echo "  [extension1 ...]      (Optional) A list of file extensions to include (e.g., .txt .md .py)."
  echo "                        If not provided, all files will be included."
  echo
  echo "Options:"
  echo "  --exclude-dir DIR     Exclude directory (can be used multiple times)"
  echo "  --exclude-file PATTERN Exclude files matching pattern (can be used multiple times)"
  echo "  --no-defaults         Don't use default excludes (VCS dirs, build dirs, temp files)"
  echo "  -h, --help            Show this help message"
  echo
  echo "Default excludes:"
  echo "  Directories: .git .svn .hg node_modules .vscode .idea __pycache__ .pytest_cache target build dist .next"
  echo "  Files: *.log *.tmp *.swp *.swo *~ .DS_Store Thumbs.db"
  echo
  echo "Examples:"
  echo "  $0 ./my_project combined_output.txt"
  echo "  $0 ./my_code combined_code.txt .js .css .html"
  echo "  $0 --exclude-dir node_modules --exclude-dir .git ./my_project output.txt"
  echo "  $0 --exclude-file '*.log' --exclude-file '*.tmp' ./my_project output.txt .txt"
  exit 1
}

# --- Argument validation ---

# Initialize arrays for excludes
exclude_dirs=()
exclude_files=()

# Add some common default excludes (can be overridden by user)
default_exclude_dirs=(".git" ".svn" ".hg" "node_modules" ".vscode" "dist-bin" "logs" ".idea" "__pycache__" ".pytest_cache" "target" "build" "dist" ".next")
default_exclude_files=("*.log" "*.tmp" "*.swp" "*.swo" "*~" ".DS_Store" "Thumbs.db")
use_defaults=true

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --exclude-dir)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --exclude-dir requires a directory name"
        exit 1
      fi
      exclude_dirs+=("$2")
      shift 2
      ;;
    --exclude-file)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --exclude-file requires a pattern"
        exit 1
      fi
      exclude_files+=("$2")
      shift 2
      ;;
    --no-defaults)
      use_defaults=false
      shift
      ;;
    -h|--help)
      usage
      ;;
    -*)
      echo "Error: Unknown option '$1'"
      usage
      ;;
    *)
      # First non-option argument should be source directory
      if [[ -z "${SOURCE_DIR:-}" ]]; then
        SOURCE_DIR="$1"
      elif [[ -z "${OUTPUT_FILE:-}" ]]; then
        OUTPUT_FILE="$1"
      else
        # Remaining arguments are extensions
        break
      fi
      shift
      ;;
  esac
done

if [[ -z "${SOURCE_DIR:-}" ]] || [[ -z "${OUTPUT_FILE:-}" ]]; then
  echo "Error: Missing required arguments."
  usage
fi

# Merge default excludes with user-specified excludes
if [ "$use_defaults" = true ]; then
  # Safely merge arrays, handling empty arrays
  if [ ${#exclude_dirs[@]} -eq 0 ]; then
    exclude_dirs=("${default_exclude_dirs[@]}")
  else
    exclude_dirs=("${default_exclude_dirs[@]}" "${exclude_dirs[@]}")
  fi
  
  if [ ${#exclude_files[@]} -eq 0 ]; then
    exclude_files=("${default_exclude_files[@]}")
  else
    exclude_files=("${default_exclude_files[@]}" "${exclude_files[@]}")
  fi
fi

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: Source directory '$SOURCE_DIR' not found."
  exit 1
fi

# --- Prepare for execution ---

# Resolve the output file path to an absolute path *before* changing directory.
# This ensures we can write to it even after `cd`.
# Use a temporary variable for the check, then assign the real path
temp_output_file="$OUTPUT_FILE"
if [[ "$OUTPUT_FILE" != /* ]]; then
  temp_output_file="$PWD/$OUTPUT_FILE"
fi
OUTPUT_FILE_ABS="$temp_output_file"


# Change to the source directory. This makes generating relative paths much easier.
cd "$SOURCE_DIR" || exit

# --- Build the 'find' command arguments ---
# Using an array is safer than building a string and using eval.
find_args=(".") # Start search from the current directory "."

# Add directory exclusions first
if [ ${#exclude_dirs[@]} -gt 0 ]; then
  for exclude_dir in "${exclude_dirs[@]}"; do
    # Match the directory at any depth, not just at root level
    find_args+=("-path" "*/$exclude_dir" "-prune" "-o")
  done
fi

# Now add the main conditions
find_args+=("-type" "f") # We only want files

# Add file exclusions
if [ ${#exclude_files[@]} -gt 0 ]; then
  for exclude_pattern in "${exclude_files[@]}"; do
    find_args+=("!" "-name" "$exclude_pattern")
  done
fi

# Add extension filters if provided
if [ "$#" -gt 0 ]; then
  find_args+=("(") # Start a group of OR conditions
  first_ext=true
  for ext in "$@"; do
    if [ "$first_ext" = false ]; then
      find_args+=("-o") # Add "or" between conditions
    fi
    # Ensure the extension has a dot, but don't add one if it's already there.
    [[ "$ext" != .* ]] && ext=".$ext"
    find_args+=("-name" "*$ext")
    first_ext=false
  done
  find_args+=(")") # End the group
fi

# Add -print0 at the end
find_args+=("-print0")

# --- Main processing loop ---

echo "Searching in '$SOURCE_DIR' and writing to '$OUTPUT_FILE_ABS'..."

# Show exclusions if any
if [ ${#exclude_dirs[@]} -gt 0 ]; then
  echo "Excluding directories: ${exclude_dirs[*]}"
fi
if [ ${#exclude_files[@]} -gt 0 ]; then
  echo "Excluding file patterns: ${exclude_files[*]}"
fi

# Clear the output file before starting
> "$OUTPUT_FILE_ABS"

# Find files and pipe them to the while loop.
# -print0 and read -d '' handle all special characters in filenames (spaces, newlines, etc.).
find "${find_args[@]}" | while IFS= read -r -d '' file; do
  # Remove the leading './' from the path for a cleaner look
  relative_path="${file#./}"
  filename=$(basename "$relative_path")

  echo "Processing: $relative_path"

  # Append the formatted block to the output file.
  # Using a block { ... } >> is efficient for redirecting multiple commands.
  {
    echo "filename: $filename"
    echo "path: $relative_path"
    echo 'content: """' # Use single quotes to prevent shell expansion inside
    # Add a check for non-readable files
    if [ -r "$relative_path" ]; then
        cat "$relative_path"
    else
        echo "!!! ERROR: Could not read file !!!"
    fi
    echo '"""'
    echo # The empty line separator
  } >> "$OUTPUT_FILE_ABS"

done

echo
echo "✅ Done. All content has been concatenated into '$OUTPUT_FILE_ABS'"