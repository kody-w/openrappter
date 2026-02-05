# 🦖 openRAPPter Installation Skill

> This skill enables any AI agent to install and configure openRAPPter locally.

## Prerequisites Check

Before installing, verify:
- [ ] Node.js 22+ is installed (`node --version`)
- [ ] npm is available (`npm --version`)
- [ ] GitHub Copilot CLI is installed (`copilot --version`)

## Installation Steps

### Step 1: Clone the Repository

```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Build the Project

```bash
npm run build
```

### Step 4: Link Globally (Optional)

```bash
npm link
```

### Step 5: Run Onboarding

```bash
openrappter onboard
```

## Verification

Test the installation:

```bash
# Check status
openrappter --status

# Expected output:
# 🦖 openRAPPter Status
#   Version: 1.0.0
#   Copilot: ✅ Available

# Test a task
openrappter --task "hello world"

# Expected: A response from the agent
```

## Quick Test Sequence

```bash
# 1. Interactive greeting
openrappter "hello"

# 2. Memory test
openrappter "remember that I installed openRAPPter successfully"

# 3. Recall test
openrappter "what do you remember?"

# 4. Skill test
openrappter "run echo 'openRAPPter works!'"

# 5. Status check
openrappter --status
```

## Troubleshooting

### Copilot CLI Not Found

```bash
# Install Copilot CLI
npm install -g @githubnext/github-copilot-cli

# Authenticate
github-copilot-cli auth
```

### Build Errors

```bash
# Clean and rebuild
rm -rf node_modules dist
npm install
npm run build
```

### Permission Errors

```bash
# Fix npm global permissions
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
```

## Python Standalone Alternative

If Node.js isn't available, use the Python version:

```bash
# Download RAPPagent.py
curl -O https://raw.githubusercontent.com/kody-w/openrappter/main/RAPPagent.py

# Make executable
chmod +x RAPPagent.py

# Run
python3 RAPPagent.py --status
python3 RAPPagent.py "hello"
```

## Full End-to-End Test

```bash
#!/bin/bash
# Complete installation and test script

set -e

echo "🦖 Installing openRAPPter..."

# Clone
git clone https://github.com/kody-w/openrappter.git
cd openrappter

# Install
npm install
npm run build
npm link

# Test
echo "Testing installation..."
openrappter --status
openrappter --task "confirm installation successful"

echo "✅ openRAPPter installed successfully!"
```

## Uninstallation

```bash
# Remove global link
npm unlink openrappter

# Remove config
rm -rf ~/.openrappter

# Remove source
rm -rf /path/to/openrappter
```

---

**Agent Notes:**
- This skill should complete in under 5 minutes
- All tests should pass before marking complete
- If Copilot CLI is unavailable, the Python version works without it
