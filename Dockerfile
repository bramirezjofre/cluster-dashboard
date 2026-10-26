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
# Two further observations pointed at musl:
#   - the same daemon run natively on the host (node 26.8.1, glibc) did
#     not crash
#   - the same daemon under gdb did not crash (timing-sensitive)
#
# musl ships its own allocator, with different behaviour under
# fragmentation and fork() from a large heap. The daemon forks 32
# concurrent `ping` processes every 60s (ARP scan) while also running
# five SSH sessions with curve25519 key exchange, which is exactly the
# workload that stresses the allocator.
#
# This image therefore uses glibc (Debian slim) and node 26 — the same
# combination that was observed to hold steady natively. The overclock
# stays untouched: the crash was reproducible on stock-frequency hardware
# too, so the clock was never the cause.
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
# iputils-ping + iproute2 give the LAN scanner its `ping` and `ip` binaries.
# avahi-daemon + avahi-utils give `avahi-resolve` for mDNS lookups (used by
# lan_enrich.js to resolve friendly hostnames like "impresora.local").
# bind9-dnsutils gives `dig`/`nslookup` for reverse-DNS fallbacks.
# The IEEE OUI database is bundled at /app/assets/oui.txt (see COPY below),
# so wireshark isn't pulled in.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gosu \
      iputils-ping \
      iproute2 \
      avahi-daemon \
      avahi-utils \
      bind9-dnsutils \
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
# Bundled IEEE OUI database — maps a 24-bit MAC prefix to the vendor name.
# ~5.6 MB compressed, used by lan_enrich.js. Keeping it in the image avoids
# a runtime download and removes the need to install wireshark.
COPY assets ./assets
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
