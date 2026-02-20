# Non-root test: installer on Ubuntu with non-root user
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y curl sudo && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user with sudo access
RUN useradd -m -s /bin/bash testuser && \
    echo "testuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Copy the installer
COPY install.sh /tmp/install.sh
RUN chmod +x /tmp/install.sh

# Switch to non-root user
USER testuser
WORKDIR /home/testuser

# Test: source the installer functions as non-root on Linux
# This tests: OS detection, build tool detection, npm prefix logic, PATH helpers
RUN bash -c '\
  export OPENRAPPTER_INSTALL_SH_NO_RUN=1 && \
  source /tmp/install.sh && \
  echo "=== OS detection ===" && \
  detect_os_or_die && \
  echo "OS=$OS" && \
  test "$OS" = "linux" && echo "OS=linux OK" && \
  echo "=== Arch detection ===" && \
  arch="$(detect_arch)" && echo "arch=$arch" && \
  test -n "$arch" && echo "arch non-empty OK" && \
  echo "=== Gum detection ===" && \
  gum_os="$(gum_detect_os)" && echo "gum_os=$gum_os" && \
  test "$gum_os" = "Linux" && echo "gum_os=Linux OK" && \
  echo "=== Constants ===" && \
  test "$INSTALL_STAGE_TOTAL" = "4" && echo "INSTALL_STAGE_TOTAL=4 OK" && \
  test "$BIN_NAME" = "openrappter" && echo "BIN_NAME OK" && \
  test -n "$NPM_PACKAGE" && echo "NPM_PACKAGE OK" && \
  echo "=== Parse args ===" && \
  parse_args --method npm --no-prompt --verbose && \
  test "$INSTALL_METHOD" = "npm" && echo "--method npm OK" && \
  test "$OPT_NO_PROMPT" = "true" && echo "--no-prompt OK" && \
  test "$VERBOSE" = "1" && echo "--verbose OK" && \
  echo "=== Install method detection ===" && \
  existing="$(detect_existing_install)" && \
  echo "existing=$existing" && \
  test "$existing" = "none" && echo "detect_existing_install=none OK" && \
  echo "=== Choose method (fresh system) ===" && \
  INSTALL_METHOD="" && \
  OPT_NO_PROMPT=true && \
  choose_install_method && \
  echo "chosen=$INSTALL_METHOD" && \
  test "$INSTALL_METHOD" = "npm" && echo "default to npm on fresh system OK" && \
  echo "=== Taglines ===" && \
  tagline="$(pick_tagline)" && test -n "$tagline" && echo "pick_tagline OK" && \
  echo "=== All non-root Linux tests passed ==="'
