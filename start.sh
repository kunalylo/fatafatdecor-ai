#!/bin/bash
set -e

echo "=== FatafatDecor Railway Start ==="

# Install Node dependencies
echo "[1/3] Installing Node dependencies..."
npm install --production

# Start FastAPI AI service in background (port 8001)
echo "[2/3] Starting FastAPI AI service on port 8001..."
uvicorn main:app --host 0.0.0.0 --port 8001 &
FASTAPI_PID=$!

# Wait briefly for FastAPI to initialise
sleep 3

# Start Express API server (Railway injects PORT)
echo "[3/3] Starting Express API on port ${PORT:-3000}..."
node server.js

# If node exits, clean up FastAPI
kill $FASTAPI_PID 2>/dev/null || true
