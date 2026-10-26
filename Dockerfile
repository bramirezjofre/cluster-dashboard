# cluster-dashboard — node 26 on Debian slim (glibc).
#
# Why node 26 + glibc instead of node 22/24 on Alpine (musl):
#
# The daemon was crashing with SIGSEGV (exit 139) 20+ times a day. The
# kernel fault resolved to V8's generational GC
# (cppgc::internal::Sweeper::PerformSweepOnMutatorThread) and, on node 24,
# to absl::container_internal::NextSeedBaseNumber()::seed — internal runtime
# functions in both cases, with valid instructions and a garbage data
# pointer. The crash offsets differed between runs, which is the signature
# of heap corruption rather than a fixed code path.
#
# Two runtimes with completely different GC implementations (V8 12.4 and
# 13.6) failed the same way, so the runtime version was not the variable.
#
# This image therefore uses glibc (Debian slim) and node 26. The overclock
# stays untouched: the crash was reproducible on stock-frequency hardware
# too, so the clock was never the cause.
#
# NOTE: the crash was ultimately traced to the LAN monitoring workload, not
# to the runtime or the libc — see docs/crash-diagnosis.md. The LAN
# subsystem has been removed from the daemon, so this image no longer needs
# any of the network helper packages either.
#
# better-sqlite3 must be >= 13: version 11.x has no prebuild for node 26
# and falls back to a source build, which fails in this image (no python
# for node-gyp). 13.x ships a NAPI prebuild and installs in seconds.
# No SSH client or keys baked in: identity files are bind-mounted from the
# host at /home/<user>/.ssh so they never enter the image or any registry.
# Build with BuildKit for faster npm install cache reuse:
#   DOCKER_BUILDKIT=1 docker build -t cluster-dashboard .
# or use docker compose build (BuildKit is on by default in recent Docker).

FROM node:26-slim
WORKDIR /app

# gosu lets the entrypoint drop privileges from root to the non-root
# user after fixing up volume permissions.
#
# No ping / iproute2 / avahi / bind9-dnsutils here any more: they existed
# only for the LAN scanner (ARP sweep, mDNS + reverse-DNS lookups) that
# was removed on 2026-10-26. Dropping them also removes the fork-heavy
# workload that triggered the daemon's SIGSEGV.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gosu \
 && rm -rf /var/lib/apt/lists/*

# Install only what's needed for runtime; no dev deps in the image.
#
# --ignore-scripts: better-sqlite3 >= 13 ships its native binding as a
# NAPI prebuild (prebuilds/linux-x64.node) inside the npm tarball.
# NAPI is ABI-stable, so the prebuild works on any node 26 without
# compiling. The package's install script would try to run node-gyp
# anyway, which fails here: this image has no python for node-gyp.
# With --ignore-scripts the prebuild is used as-is.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

COPY src ./src
COPY public ./public
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The daemon runs as a non-root user (matches the host user's UID/GID
# so SSH files bind-mounted at /home/<user>/.ssh are readable). If the
# host user is different, pass BUILD_UID/BUILD_GID at docker build time.
# The entrypoint runs as root so it can chown the volume, then drops to
# the build user via gosu before exec-ing the node process.
ARG BUILD_UID=1000
ARG BUILD_GID=1000

# /data exists at image build time as root, but the named volume mounted
# at /data overrides it at container start. The entrypoint chowns that
# mount so the non-root daemon can write to it.
RUN mkdir -p /data

# Pass build-time UID/GID to the entrypoint at runtime via env so it
# can drop privileges to the same user.
ENV BUILD_UID=${BUILD_UID}
ENV BUILD_GID=${BUILD_GID}

ENV PORT=9090
EXPOSE 9090
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
