# PY-BoomBoom tasks. Run `just` to list them. Set FW_PORT to use another port (default 5317).

port := env_var_or_default("FW_PORT", "5317")

default: list

# List the recipes
list:
    @just --list

# Install the dependencies
install:
    npm install

# Start the server in the background and print the link (PID in .run/server.pid, log in .run/server.log)
start:
    #!/usr/bin/env bash
    set -eu
    mkdir -p .run
    url="http://localhost:{{port}}/"
    # Only a live process that really is our vite server counts (a stale PID file may name a reused PID).
    if [ -f .run/server.pid ] && kill -0 "$(cat .run/server.pid)" 2>/dev/null && ps -p "$(cat .run/server.pid)" -o command= | grep -q "vite.js"; then
      echo "Already running (PID $(cat .run/server.pid))."
      echo "Open: $url"
      exit 0
    fi
    rm -f .run/server.pid
    FW_PORT={{port}} nohup node node_modules/vite/bin/vite.js >> .run/server.log 2>&1 &
    echo $! > .run/server.pid
    for _ in $(seq 1 60); do
      if curl -fs -o /dev/null "http://127.0.0.1:{{port}}/"; then
        echo "Started (PID $(cat .run/server.pid))."
        echo ""
        echo "  Open in your browser: $url"
        echo "  Or: http://127.0.0.1:{{port}}/"
        echo ""
        exit 0
      fi
      kill -0 "$(cat .run/server.pid)" 2>/dev/null || break
      sleep 0.5
    done
    pid="$(cat .run/server.pid)"; rm -f .run/server.pid
    kill "$pid" 2>/dev/null || true
    echo "The server did not start. Is port {{port}} in use? Last log lines:"
    tail -n 8 .run/server.log
    exit 1

# Show whether the server runs, and the link
status:
    #!/usr/bin/env bash
    if [ -f .run/server.pid ] && kill -0 "$(cat .run/server.pid)" 2>/dev/null && ps -p "$(cat .run/server.pid)" -o command= | grep -q "vite.js"; then
      echo "Running (PID $(cat .run/server.pid)): http://localhost:{{port}}/"
    else
      echo "Not running."
    fi

# Open the app in the default browser
open:
    #!/usr/bin/env bash
    url="http://localhost:{{port}}/"
    if command -v open >/dev/null 2>&1; then open "$url"; else xdg-open "$url"; fi

# Stop the server started by `just start`
stop:
    #!/usr/bin/env bash
    set -u
    if [ ! -f .run/server.pid ]; then echo "Not running."; exit 0; fi
    pid="$(cat .run/server.pid)"
    rm -f .run/server.pid
    # Only stop the process if it is still our vite server (the PID may have been reused).
    if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -q "vite.js"; then
      kill "$pid"
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      if kill -0 "$pid" 2>/dev/null; then echo "PID $pid is still running after 5 s."; exit 1; fi
      echo "Stopped (PID $pid)."
    else
      echo "Not running (removed a stale PID file)."
    fi

# Run the three check suites in order (verify wipes verification/, so it runs first)
test:
    npm run verify
    npm run verify:ui
    npm run verify:blender

# Make the preset rollover loops again (public/preset-loops)
loops:
    npm run loops

# Make the README demo GIFs again (docs/gifs)
gifs:
    npm run gifs
