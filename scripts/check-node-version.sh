#!/bin/bash
# Helper script to ensure Node.js version >=22

REQUIRED_MAJOR=22
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)

if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
  echo "Error: Node.js $REQUIRED_MAJOR or higher is required. Current version: $(node -v)" >&2
  return 1 2>/dev/null || exit 1
fi

