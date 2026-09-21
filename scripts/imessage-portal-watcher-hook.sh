#!/bin/bash
# Source this file from the existing watcher; it starts nothing by itself.

imessage_portal_owns_text() {
  [[ "${1-}" =~ ^[[:space:]]*[Rr][Aa][Pp][Pp]([[:space:]:]|$) ]] \
    || [[ "${1-}" =~ ^[[:space:]]*\[[Rr][Aa][Pp][Pp][[:space:]] ]]
}

imessage_portal_tick() {
  [ -n "${RAPP_PORTAL_CONFIG:-}" ] || return 0
  if [ -z "${RAPP_PORTAL_PYTHON:-}" ] || [ -z "${RAPP_PORTAL_SOURCE:-}" ]; then
    if declare -F log >/dev/null; then log "RAPP portal hook has incomplete local configuration"; fi
    return 1
  fi
  if ! RAPP_PORTAL_WATCHER_INSTANCE="$$" \
      "$RAPP_PORTAL_PYTHON" "$RAPP_PORTAL_SOURCE/scripts/imessage-portal.py" \
      --config "$RAPP_PORTAL_CONFIG" tick; then
    if declare -F log >/dev/null; then log "RAPP portal transport needs attention; private state retained"; fi
    return 1
  fi
}
