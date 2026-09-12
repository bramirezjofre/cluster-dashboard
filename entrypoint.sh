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

# Compose PIHOLE_HOSTS from individual entries so passwords never appear
# in docker-compose.yml. Each pair PIHOLE_HOST_N / PIHOLE_PASSWORD_N is
# optional; only defined pairs are assembled. Result format:
#   "host:port:password,host:port:password"
#
# Two pitfalls avoided here:
#   1. `$$` in docker compose's .env becomes literal `$` BEFORE the script
#      runs. So a password like `Pa$$w0rd` arrives as `Pa$w0rd` to this
#      script. Storing it back via `printf %s` (rather than eval) keeps
#      it intact.
#   2. bash/dash don't allow `${PIHOLE_HOST_$n:-}` in all POSIX sh variants.
#      Workaround: read each value with `printenv` (an external command)
#      which returns the literal value of a named variable.
if [ -z "${PIHOLE_HOSTS:-}" ]; then
  PIHOLE_HOSTS=""
  for n in 1 2 3 4 5; do
    # printenv returns the literal value (no expansion), so passwords
    # with `$` survive untouched. If the env var doesn't exist, it
    # exits non-zero; fall back to empty.
    h=$(printenv "PIHOLE_HOST_${n}" 2>/dev/null || true)
    p=$(printenv "PIHOLE_PASSWORD_${n}" 2>/dev/null || true)
    if [ -n "$h" ] && [ -n "$p" ]; then
      if [ -z "$PIHOLE_HOSTS" ]; then
        PIHOLE_HOSTS="${h}:${p}"
      else
        PIHOLE_HOSTS="${PIHOLE_HOSTS},${h}:${p}"
      fi
    fi
  done
  export PIHOLE_HOSTS
fi

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