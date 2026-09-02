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
RUN apk add --no-cache gosu

# Install only what's needed for runtime; no dev deps in the image.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
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