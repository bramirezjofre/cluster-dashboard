# cluster-dashboard — slim Node image, ~80 MB final.
# No SSH client or keys baked in: identity files are bind-mounted from the
# host at /home/<user>/.ssh so they never enter the image or any registry.
# Build with BuildKit for faster npm install cache reuse:
#   DOCKER_BUILDKIT=1 docker build -t cluster-dashboard .
# or use docker compose build (BuildKit is on by default in recent Docker).

FROM node:22-alpine
WORKDIR /app

# Install only what's needed for runtime; no dev deps in the image.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

# Non-root for the daemon (matches the host user's UID/GID so SSH files
# bind-mounted from /home/<user>/.ssh are readable). If the host user is
# different, pass BUILD_UID/BUILD_GID at docker build time.
ARG BUILD_UID=1000
ARG BUILD_GID=1000
USER ${BUILD_UID}:${BUILD_GID}

ENV PORT=9090
EXPOSE 9090
CMD ["node", "src/server.js"]