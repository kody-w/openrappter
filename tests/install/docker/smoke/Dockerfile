# Smoke test: npm install method (root user) using local tarball
FROM node:22-slim

RUN apt-get update && apt-get install -y curl git build-essential && rm -rf /var/lib/apt/lists/*

# Copy local tarball and install it as if it were from npm
COPY openrappter-*.tgz /tmp/openrappter.tgz
RUN npm install -g /tmp/openrappter.tgz --no-fund --no-audit

# Verify binary exists and works
RUN which openrappter && openrappter --version

# Copy installer and test that functions source correctly on Linux
COPY install.sh /tmp/install.sh
RUN chmod +x /tmp/install.sh

# Test: source the installer and run function checks
RUN bash -c '\
  export OPENRAPPTER_INSTALL_SH_NO_RUN=1 && \
  source /tmp/install.sh && \
  echo "=== OS detection ===" && \
  detect_os_or_die && \
  echo "OS=$OS" && \
  echo "=== Arch detection ===" && \
  echo "arch=$(detect_arch)" && \
  echo "=== Install method detection ===" && \
  echo "existing=$(detect_existing_install)" && \
  echo "=== Build tools ===" && \
  command -v gcc && echo "gcc OK" && \
  command -v make && echo "make OK" && \
  echo "=== PATH helpers ===" && \
  path_has_dir "/usr/local/bin:/usr/bin" "/usr/bin" && echo "path_has_dir OK" && \
  echo "=== All function tests passed ==="'
