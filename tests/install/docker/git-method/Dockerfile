# Git method test: install via git clone
FROM node:22-slim

RUN apt-get update && apt-get install -y curl git build-essential && rm -rf /var/lib/apt/lists/*

# Resolve the manifest from the exact PR/head revision under test. This changes
# only where the pointer document is read; release identity remains the closed
# manifest's exact source commit and SHA-256.
ARG MANIFEST_REF=main
ENV OPENRAPPTER_MANIFEST_REF=$MANIFEST_REF

# Copy the installer
COPY install.sh /opt/openrappter-install.sh
RUN chmod +x /opt/openrappter-install.sh

# Run installer with git method, non-interactive
RUN bash /opt/openrappter-install.sh --method git --no-onboard --no-copilot --no-prompt

# Verify launcher script was created
RUN test -x /usr/local/bin/openrappter || test -x /root/.local/bin/openrappter

# Verify git clone directory exists
RUN test -d /root/.openrappter/.git

# Verify binary works
RUN bash -l -c 'openrappter --version'
