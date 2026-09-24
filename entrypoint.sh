#!/bin/sh
# cluster-dashboard entrypoint.
#
# Runs as root to:
#   1. chown /data (the named volume mountpoint) to BUILD_UID:BUILD_GID
#      so the non-root daemon can write to it.
#   2. chown /app/src and /app/public so SSH files (if bind-mounted
#      later) and the daemon code are owned by the right user.
#   3. chown /home/bramirezj/.ssh if it was bind-mounted (read-only,
#      but the daemon needs to traverse it).
#
# Then drops privileges to BUILD_UID:BUILD_GID via gosu and exec's the
# CMD (node src/server.js by default). gosu is preferred over su because
# it doesn't fork+exec the PAM stack — the node process becomes PID 1's
# direct child, so SIGTERM from `docker stop` reaches it directly.

set -e

BUILD_UID="${BUILD_UID:-1000}"
BUILD_GID="${BUILD_GID:-1000}"

echo "entrypoint: chown /data to ${BUILD_UID}:${BUILD_GID}"
chown -R "${BUILD_UID}:${BUILD_GID}" /data || {
  echo "entrypoint: chown failed (continuing — maybe volume already correct)"
}

# /home/bramirezj/.ssh may be read-only bind-mounted. We only chown
# /home/bramirezj itself, never touch .ssh contents.
if [ -d /home/bramirezj ]; then
  chown "${BUILD_UID}:${BUILD_GID}" /home/bramirezj || true
fi

echo "entrypoint: dropping to ${BUILD_UID}:${BUILD_GID} via gosu"
exec gosu "${BUILD_UID}:${BUILD_GID}" "$@"