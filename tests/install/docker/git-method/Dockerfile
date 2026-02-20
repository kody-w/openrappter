# Git method test: install via git clone
FROM node:22-slim

RUN apt-get update && apt-get install -y curl git build-essential && rm -rf /var/lib/apt/lists/*

# Copy the installer
COPY install.sh /tmp/install.sh
RUN chmod +x /tmp/install.sh

# Run installer with git method, non-interactive
RUN bash /tmp/install.sh --method git --no-onboard --no-copilot --no-prompt

# Verify launcher script was created
RUN test -x /usr/local/bin/openrappter || test -x /root/.local/bin/openrappter

# Verify git clone directory exists
RUN test -d /root/.openrappter/.git

# Verify binary works
RUN bash -l -c 'openrappter --version'
