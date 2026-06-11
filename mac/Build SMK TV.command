#!/bin/bash
# Double-click to build a new SMK TV.exe
# Goes up one level to the project root, then runs build.cjs
cd "$(dirname "$0")/.."

echo ""
echo "  SMK TV — Auto Builder"
echo "  ========================="
echo ""

if ! command -v node &> /dev/null; then
  echo "  ERROR: Node.js is not installed."
  echo "  Download from: https://nodejs.org"
  read -p "  Press Enter to close..."
  exit 1
fi

node build.cjs
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "  Done! Check the windows/exe/ folder for the new build."
  open "$(pwd)/windows/exe"
else
  echo "  Build failed. Check the output above."
fi

echo ""
read -p "  Press Enter to close..."
