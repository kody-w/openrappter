---
name: tmux
description: Manage terminal multiplexer sessions for persistent shell environments.
metadata: {"openclaw":{"emoji":"🧵","os":["darwin","linux"],"requires":{"bins":["tmux"]}}}
---

# tmux

Terminal multiplexer for persistent sessions.

## Create a Session

```bash
tmux new-session -d -s mysession
```

## Send Commands

```bash
tmux send-keys -t mysession "echo hello" Enter
```

## Capture Output

```bash
tmux capture-pane -p -t mysession -S -100
```

## List Sessions

```bash
tmux list-sessions
```

## Kill a Session

```bash
tmux kill-session -t mysession
```

## Custom Socket (Isolation)

```bash
SOCKET="/tmp/openrappter-tmux.sock"
tmux -S "$SOCKET" new -d -s isolated
tmux -S "$SOCKET" send-keys -t isolated "command" Enter
tmux -S "$SOCKET" capture-pane -p -t isolated
tmux -S "$SOCKET" kill-session -t isolated
```
