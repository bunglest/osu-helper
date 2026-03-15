#!/usr/bin/env bash
set -e

echo ""
echo "  🎯 osu!helper — Beatmap Recommender"
echo ""

# Check python
if ! command -v python3 &>/dev/null; then
  echo "  ERROR: python3 is not installed."
  exit 1
fi

# Install deps
echo "  Installing dependencies..."
pip3 install -r requirements.txt -q

echo "  Starting server at http://localhost:5000"
echo "  Press Ctrl+C to stop."
echo ""
python3 app.py
