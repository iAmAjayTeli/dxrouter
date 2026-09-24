#!/bin/sh
# Build and run DXRouter from this checkout.
#
# Kept in step with docker-compose.yml: same locally built image tag, same port, same
# volume. It used to build and run as `9router` on port 20128 — upstream's name and port —
# which after the Dockerfile moved to 20127 published host 20128 to a container port
# nothing listens on, so the container started and was unreachable.
#
# The volume stays `9router-data` deliberately, for the same reason src/lib/dataDir.js
# keeps the directory name: renaming it orphans the database, credentials and usage history
# of every deployment that already has one.
#
# DXR_ALLOW_NETWORK is required, not optional: the image sets HOSTNAME=0.0.0.0 because a
# container must bind all interfaces for -p to work, and the server refuses a non-loopback
# bind without this explicit opt-in. Put DXR_MASTER_KEY (64 hex chars) in .env, or the
# server refuses to start rather than store provider credentials unencrypted.
set -e

docker stop dxrouter 2>/dev/null || true
docker rm dxrouter 2>/dev/null || true
docker build -t dxrouter:local .
docker run -d --name dxrouter \
  -p 127.0.0.1:20127:20127 \
  --env-file .env \
  -e DXR_ALLOW_NETWORK=1 \
  -v 9router-data:/app/data \
  dxrouter:local
