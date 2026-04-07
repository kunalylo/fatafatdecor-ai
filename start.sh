#!/bin/bash
set -e

echo "=== FatafatDecor Railway Start ==="

# Start FastAPI AI service in background on port 8001
echo "[1/2] Starting FastAPI on :8001..."
uvicorn main:app --host 0.0.0.0 --port 8001 &

# Start Express API on Railway PORT (foreground — keeps container alive)
echo "[2/2] Starting Express on :${PORT:-3000}..."
exec node server.js
