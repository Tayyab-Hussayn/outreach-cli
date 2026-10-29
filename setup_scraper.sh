#!/usr/bin/env bash
# Setup script for Google Maps Scraper dependencies using root .venv
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

echo "======================================================"
echo "    Google Maps Scraper - Dependency Setup            "
echo "======================================================"

if [ ! -d "$VENV_DIR" ]; then
    echo "[1/2] Creating Python virtual environment in $VENV_DIR (.venv)..."
    python3 -m venv "$VENV_DIR"
else
    echo "[1/2] Existing .venv virtual environment found."
fi

echo "[2/2] Installing core scraper dependencies (botasaurus, lxml, regex, etc.)..."
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install botasaurus dateutils unidecode lxml regex beautifulsoup4 requests

echo ""
echo "======================================================"
echo "✓ Scraper setup completed successfully in .venv!"
echo "You can now use /scrape <query> [max] inside Outreach CLI."
echo "======================================================"
