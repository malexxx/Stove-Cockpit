#!/bin/sh
set -e

# Rétro-compatibilité Synology / Watchtower : si l'ancien conteneur a conservé
# l'ancien CMD ("uvicorn main:app ..."), redirige automatiquement vers server.py
# afin que la résolution HTTPS/TLS autonome soit toujours active.
if [ "$1" = "uvicorn" ] && [ "$2" = "main:app" ]; then
    shift 2
    set -- python server.py "$@"
fi

if [ "$(id -u)" = "0" ]; then
    TARGET_DATA_DIR="/app/data"
    if [ -n "${DB_PATH:-}" ]; then
        RESOLVED_DIR="$(python -c 'import os, sys; sys.path.insert(0, "/app"); from config import resolve_data_dir; print(resolve_data_dir(os.environ.get("DB_PATH", ""), "/app/data"))' 2>/dev/null || true)"
        if [ -n "$RESOLVED_DIR" ]; then
            TARGET_DATA_DIR="$RESOLVED_DIR"
        fi
    fi
    mkdir -p /app/data "$TARGET_DATA_DIR"
    chown -R nobis:nobis /app/data
    if [ "$TARGET_DATA_DIR" != "/app/data" ]; then
        chown -R nobis:nobis "$TARGET_DATA_DIR"
    fi
    exec gosu nobis:nobis "$@"
fi

exec "$@"
