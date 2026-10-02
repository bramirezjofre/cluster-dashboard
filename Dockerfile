# cluster-dashboard — slim Node image, ~80 MB final.
# No SSH client or keys baked in: identity files are bind-mounted from the
# host at /home/<user>/.ssh so they never enter the image or any registry.
# Build with BuildKit for faster npm install cache reuse:
#   DOCKER_BUILDKIT=1 docker build -t cluster-dashboard .
# or use docker compose build (BuildKit is on by default in recent Docker).

FROM node:22-alpine
WORKDIR /app

# gosu lets the entrypoint drop privileges from root to the non-root
# user after fixing up volume permissions. Tiny static binary (~1.5 MB).
# avahi-tools gives us `avahi-resolve` for mDNS lookups (used by
# lan_enrich.js to resolve friendly hostnames like "impresora.local").
# bind-tools gives us `getent`/`nslookup`/`dig` for reverse-DNS
# fallbacks. The IEEE OUI database is bundled at /app/assets/oui.txt
# (see COPY below), so wireshark isn't pulled in.
RUN apk add --no-cache gosu avahi-tools bind-tools

# Install only what's needed for runtime; no dev deps in the image.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
# Bundled IEEE OUI database — maps a 24-bit MAC prefix to the vendor name.
# ~5.6 MB compressed, used by lan_enrich.js. Keeping it in the image avoids
# a runtime download and removes the need to install wireshark.
COPY assets ./assets
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The daemon runs as a non-root user (matches the host user's UID/GID
# so SSH files bind-mounted from /home/<user>/.ssh are readable). If the
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