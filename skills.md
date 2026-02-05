# 🦖 openrappter Installation Skill

> This skill enables any AI agent to install and configure openrappter locally.

## Prerequisites Check

Before installing, verify:
- [ ] Node.js 18+ is installed (`node --version`) — for TypeScript runtime
- [ ] Python 3.10+ is installed (`python3 --version`) — for Python runtime
- [ ] GitHub Copilot CLI is installed (`copilot --version`) — optional but recommended

## Installation Steps

### Step 1: Clone the Repository

```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter
```

### Step 2a: TypeScript Runtime

```bash
cd typescript
npm install
npm run build
```

### Step 2b: Python Runtime

```bash
cd python
pip install -e .
```

## Verification

Test the installation:

```bash
# TypeScript
cd typescript
node dist/index.js --status

# Expected output:
# 🦖 openrappter Status
#   Version: 1.1.0
#   Agents: 2 loaded

# Python
cd python
python3 -m openrappter.cli --status
# or if installed:
openrappter --status
```

## Quick Test Sequence

### TypeScript

```bash
cd typescript

# 1. Check status
node dist/index.js --status

# 2. Memory test
node dist/index.js "remember that I installed openrappter"

# 3. Recall test
node dist/index.js "recall openrappter"

# 4. Shell test
node dist/index.js "ls"
```

### Python

```bash
cd python

# 1. Check status
python3 -m openrappter.cli --status

# 2. List agents
python3 -m openrappter.cli --list-agents

# 3. Memory test
python3 -m openrappter.cli "remember that Python works"
```

## Troubleshooting

### Copilot CLI Not Found

The agent works without Copilot CLI (uses keyword matching fallback):

```bash
# Optional: Install Copilot CLI for enhanced functionality
npm install -g @githubnext/github-copilot-cli
github-copilot-cli auth
```

### TypeScript Build Errors

```bash
cd typescript
rm -rf node_modules dist
npm install
npm run build
```

### Python Import Errors

```bash
cd python
pip install -e .
# or run directly:
python3 -m openrappter.cli --status
```

## Uninstallation

```bash
# Remove config
rm -rf ~/.openrappter

# Remove source
rm -rf /path/to/openrappter
```

---

**Agent Notes:**
- This skill should complete in under 5 minutes
- Both runtimes can be installed independently
- TypeScript and Python use the same agent pattern
