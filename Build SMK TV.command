#!/bin/bash
# Double-click this file on macOS to build a new SMK TV.exe
cd "$(dirname "$0")"

echo ""
echo "  SMK TV — Auto Builder"
echo "  ========================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "  ERROR: Node.js is not installed."
  echo "  Download from: https://nodejs.org"
  echo ""
  read -p "  Press Enter to close..."
  exit 1
fi

node build.cjs
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "  Done! Check the 'exe/' folder for the new build."
  # Open the exe/ folder in Finder
  open "$(dirname "$0")/exe"
else
  echo "  Build failed. Check the output above for errors."
fi

echo ""
read -p "  Press Enter to close..."
