# Docker

Run DXRouter in a container, built from this checkout.

**There is no published DXRouter image to pull yet.** The publish workflow
(`.github/workflows/docker-publish.yml`) fires only on a `v*` tag push, and this
repository has no remote tags, so nothing has been published. Build locally instead — the
same thing `captain-definition` does.

Do not pull `decolua/9router`. That is upstream 9Router's image; running it gives you a
working 9Router and no DXRouter, on a different port, which is exactly the confusion this
document used to cause.

---

# 👤 For Users

## Quick start

```bash
docker build -t dxrouter:local .

docker run -d \
  -p 127.0.0.1:20127:20127 \
  -v "$HOME/.9router:/app/data" \
  -e DXR_DATA_DIR=/app/data \
  -e DXR_ALLOW_NETWORK=1 \
  -e DXR_MASTER_KEY="$(openssl rand -hex 32)" \
  --name dxrouter \
  dxrouter:local
```

App listens on port `20127`. Open: http://localhost:20127

Two of those flags are not optional in a container, and the server refuses to start
without them rather than starting insecurely:

- `DXR_ALLOW_NETWORK=1` — a container must bind all interfaces for `-p` to work at all,
  and a non-loopback bind requires this explicit opt-in.
- `DXR_MASTER_KEY` — 64 hex characters, encrypting provider credentials at rest. There is
  no OS keychain inside the container to fall back on. Generate it **once** and keep it;
  a new key cannot decrypt credentials stored under the old one.

Publishing the port as `127.0.0.1:20127:20127` keeps it on the host only. Binding it
without the `127.0.0.1:` prefix exposes the LLM API and every stored provider credential
to anything that can reach the host.

## Compose

```bash
docker compose up -d --build
```

`docker-compose.yml` builds this checkout, publishes `20127:20127`, and runs the optional
Headroom sidecar. Put `DXR_MASTER_KEY` in `.env` next to the compose file.

## Manage container

```bash
docker logs -f dxrouter        # view logs
docker stop dxrouter           # stop
docker start dxrouter          # start again
docker rm -f dxrouter          # remove
```

## Data persistence

```bash
-v "$HOME/.9router:/app/data" \
-e DXR_DATA_DIR=/app/data
```

The host directory is still `~/.9router`, and the compose volume is still `9router-data`.
That is deliberate: renaming either would orphan the database, credentials and usage
history of every existing install. `src/lib/dataDir.js` keeps the directory name for the
same reason. Where an install keeps its data and what product it is are separate
questions.

`DATA_DIR` is still honoured but deprecated and warns on every start; `DXR_DATA_DIR` is
the canonical variable and the one the image sets by default.

Data layout under `$DXR_DATA_DIR/`:

```text
$DXR_DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 127.0.0.1:20127:20127 \
  -v "$HOME/.9router:/app/data" \
  -e DXR_DATA_DIR=/app/data \
  -e DXR_ALLOW_NETWORK=1 \
  -e DXR_MASTER_KEY=... \
  -e PORT=20127 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name dxrouter \
  dxrouter:local
```

`PORT` is worth setting explicitly even though the image already defaults to it: the
server treats an explicitly configured `PORT` as proof of which port it bound, and uses a
defaulted one only for display. See `resolveProvenPort` in `src/lib/dxrInstallation.js`.

## Optional Headroom sidecar

The DXRouter image does not bundle Python or Headroom. To use Headroom in Docker, run it
as a separate service and point DXRouter at that proxy:

```yaml
services:
  dxrouter:
    build: .
    ports:
      - "127.0.0.1:20127:20127"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DXR_DATA_DIR: /app/data
      DXR_ALLOW_NETWORK: "1"
      DXR_MASTER_KEY: "${DXR_MASTER_KEY}"
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is
`http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use
`http://host.docker.internal:8787` on macOS/Windows. On Linux, add
`--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts`
entry.

## Update

```bash
git pull
docker compose up -d --build       # or: docker build -t dxrouter:local .
```

There is no `docker pull` step, because there is no published image. Self-update is
disabled in the application for the same reason — `POST /api/version/update` answers
`409` — so updating means rebuilding from a newer checkout.

---

# 🛠 For Developers

## Build image locally

```bash
docker build -t dxrouter:local .

docker run --rm -p 127.0.0.1:20127:20127 \
  -v "$HOME/.9router:/app/data" \
  -e DXR_DATA_DIR=/app/data \
  -e DXR_ALLOW_NETWORK=1 \
  -e DXR_MASTER_KEY=... \
  dxrouter:local
```

The build context is the repository root (`captain-definition` points at `./Dockerfile`),
and `.dockerignore` excludes `node_modules`, `.next`, `data`, `logs` and local env files.

## Publish (automatic via CI)

Push a git tag `v*` → GitHub Actions builds multi-platform (amd64 + arm64) and pushes to
GHCR only:

- `ghcr.io/iamajayteli/dxrouter:{version}` — e.g. tag `v0.5.60` publishes `:0.5.60`
- `ghcr.io/iamajayteli/dxrouter:latest` — default branch only

Note the version tag carries **no** `v` prefix: the workflow uses
`type=semver,pattern={{version}}`.

```bash
git tag v0.5.61 && git push origin v0.5.61
```

Docker Hub is deliberately not a target. The workflow used to push a second copy to
`decolua/9router`, which is upstream's namespace; adding a Docker Hub target back means
creating a DXRouter-owned repository first.

Workflow: `.github/workflows/docker-publish.yml`

## No healthcheck is defined

Neither the Dockerfile nor the compose file declares one, so nothing currently probes
liveness. `GET /api/health` is unauthenticated and would serve as the probe target if one
is added later; it was left out of the Docker identity work because adding it changes
runtime behaviour rather than identity.
