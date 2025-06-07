#!/bin/bash
# Setup script for AI Hub Apps

echo "Setting up AI Hub Apps..."

# Install root dependencies
echo "Installing root dependencies..."
npm install

# Install client dependencies
echo "Installing client dependencies..."
cd client
npm install
npm install @vitejs/plugin-react --save-dev
cd ..

# Install server dependencies if package.json exists
if [ -f "server/package.json" ]; then
  echo "Installing server dependencies..."
  cd server
  npm install
  cd ..
fi

echo "Setup complete! You can now run 'npm run dev' to start the application." 