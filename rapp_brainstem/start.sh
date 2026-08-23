#!/bin/bash
set -e
cd "$(dirname "$0")"

BRAINSTEM_HOME="$HOME/.brainstem"
VENV_PYTHON="$BRAINSTEM_HOME/venv/bin/python"

python_supported() {
    "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

# Use venv if available; create it if missing
if [ ! -x "$VENV_PYTHON" ]; then
    echo "Setting up virtual environment..."
    PYTHON_CMD=""
    for candidate in python3.14 python3.13 python3.12 python3.11 python3 python; do
        candidate_path=$(command -v "$candidate" 2>/dev/null || true)
        if [ -n "$candidate_path" ] && python_supported "$candidate_path"; then
            PYTHON_CMD="$candidate_path"
            break
        fi
    done
    if [ -z "$PYTHON_CMD" ]; then
        echo "ERROR: Python 3.11+ not found. Install it from https://python.org, or run the installer:"
        echo "  curl -fsSL https://microsoft.github.io/aibast-agents-library/install.sh | bash"
        exit 1
    fi
    "$PYTHON_CMD" -m venv "$BRAINSTEM_HOME/venv" 2>/dev/null || {
        echo "Failed to create venv — run the installer: curl -fsSL https://microsoft.github.io/aibast-agents-library/install.sh | bash"
        exit 1
    }
fi

if ! python_supported "$VENV_PYTHON"; then
    echo "ERROR: The managed environment uses Python older than 3.11."
    echo "       Remove $BRAINSTEM_HOME/venv and rerun the launcher to rebuild it."
    exit 1
fi

# Install deps if needed
if ! "$VENV_PYTHON" -c "import flask, flask_cors, requests, dotenv, pyzipper" 2>/dev/null; then
    echo "Installing dependencies..."
    if ! "$VENV_PYTHON" -m pip --version >/dev/null 2>&1; then
        "$VENV_PYTHON" -m ensurepip --upgrade --default-pip
    fi
    "$VENV_PYTHON" -m pip install -r requirements.txt -q
fi

# Create .env from example if missing
if [ ! -f .env ]; then
    cp .env.example .env 2>/dev/null || true
fi

# Repair permissive modes from older installers before the server reads secrets.
chmod 600 .env 2>/dev/null || true
for private_file in .copilot_token .copilot_session .copilot_pending .brainstem_secret voice.zip; do
    if [ -f "$private_file" ]; then
        chmod 600 "$private_file" 2>/dev/null || true
    fi
done

exec "$VENV_PYTHON" brainstem.py
