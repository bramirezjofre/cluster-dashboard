# cluster-dashboard

Self-hosted dashboard that polls a fleet of servers over SSH and renders
uptime / CPU / RAM / disk / container metrics with sparklines. Runs as a
single Docker container; nothing is installed on the host beyond the
container itself.

## How it works

- One Node.js process per dashboard container
- On startup, reads `/home/<user>/.ssh/config` for the aliases it should
  poll (default: `server-11,server-17,server-18,server-19`)
- Every `POLL_INTERVAL_MS` (default 30s) it SSHes to each server, runs
  one tiny shell script that prints `key=value` lines for hostname, kernel,
  distro, uptime, load, cpu%, memory, disks, network counters, and
  docker container count
- Keeps a ring buffer of the last `HISTORY_SAMPLES` samples (default 120
  = 1h at 30s) per metric, per server, in memory
- Serves the dashboard HTML and a JSON snapshot from `/api/cluster/status`
- Polls the local LAN via ARP scan and reads host NIC byte counters
  (rx/tx Kbps) so we can see traffic flowing through the host's LAN
  interface (see "LAN monitoring" below). Available at
  `/api/lan/status`, `/api/lan/history`, `/api/iface/status`, and
  `/api/iface/history`.

## What it does NOT do

- It does not modify the remote servers — no install, no agent, no
  persistent daemon on them. Every metric is collected via one SSH exec
  per poll per server.
- It does not store credentials. The container reads SSH identity files
  mounted read-only from the host; no keys are baked into the image.
- It does not persist history to disk. A restart loses the ring buffer;
  that's intentional for a single-host dashboard.

## LAN monitoring

The daemon also tracks what's happening on the local network:

- **ARP scan** of `LAN_SUBNET` (default `192.168.1.0/24`) every
  `LAN_POLL_INTERVAL_MS` (default 60s). Result is a table of IP + MAC
  pairs for active hosts, shown in the "Dispositivos LAN" card.
- **Interface traffic** for the host's LAN-facing NIC (default
  `enp2s0`) every `IFACE_POLL_INTERVAL_MS` (default 30s). The
  daemon reads `/sys/class/net/<iface>/statistics/{rx,tx}_bytes` and
  derives Kbps from the delta. Shown in the "Tráfico LAN" card with
  a sparkline of the last 30 minutes.

### Configuring interface traffic

The "Tráfico LAN" card shows real-time RX/TX Kbps on the host's LAN
interface by reading `/sys/class/net/<iface>/statistics/{rx,tx}_bytes`
every `IFACE_POLL_INTERVAL_MS` (default 30s) and deriving Kbps from
the delta. Total bytes since boot is also shown.

**Required:** the container must run with `network_mode: host` (set in
`docker-compose.yml`) so it can read host counters. If you see only
docker bridge traffic, verify the `network_mode: host` line is present.

Override defaults via `.env`:

```ini
IFACE=enp2s0              # LAN-facing NIC. 'eth0' on Raspberry Pi hosts.
IFACE_POLL_INTERVAL_MS=30000
IFACE_HISTORY_SAMPLES=1440  # in-memory ring buffer; long-term lives in SQLite.
```

### Configuring the ARP subnet

`LAN_SUBNET` (default `192.168.1.0/24`) is the subnet the ARP scanner
pings to populate the "Dispositivos LAN" card. Override if your ISP
router uses a different range.

### Endpoints

- `GET /api/lan/status` — current snapshot: `{ arp: { ts, devices[] },
  lastError: string|null }`
- `GET /api/lan/history?source=arp&from=<ms>&to=<ms>&limit=<n>` —
  historical ARP samples (default: last 24h, max 5000 rows)
- `GET /api/iface/status` — current iface counters: `{ iface, ts,
  rxBytes, txBytes, rxKbps, txKbps, ok, error }`
- `GET /api/iface/history?from=<ms>&to=<ms>&limit=<n>` — historical
  samples for the default interface

### Caveats

- ARP scan only sees devices that respond to ping or have an existing
  ARP entry. A powered-off device disappears from the list until it
  comes back. The Samsung S20fe this dashboard runs on is a typical
  example — it appears only when awake.
- Interface traffic reflects only what's flowing through the host's
  LAN NIC. Devices on a different physical segment (e.g. behind a
  separate AP) won't be visible.
- The container runs with `network_mode: host` so the ARP scan can
  reach the LAN. Without it the container only sees its own docker
  bridge subnet (172.x).

## Tests

A standalone test image (`Dockerfile.test`) runs the unit tests on
Node 22-alpine, which avoids polluting the host's `node_modules` and
sidesteps the better-sqlite3 native build issue some Node versions
have:

```bash
docker build -f Dockerfile.test -t cluster-dashboard-test .
docker run --rm cluster-dashboard-test
```

Or via Compose, using the `test` profile so `docker compose up` doesn't
start it:

```bash
docker compose run --rm test
```

The test suite currently covers `src/arp.js` (ARP cache parsing) and
`src/iface_traffic.js` (byte counter parser, Kbps derivation, sample
function). Tests use `node --test`, no extra dependencies.

## Layout

```
cluster-dashboard/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── src/server.js          # daemon: ssh poll loop + JSON API + static serve
└── public/index.html      # frontend: cards + sparklines + auto-refresh
```

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `PORT` | 9090 | HTTP listen port inside the container |
| `POLL_INTERVAL_MS` | 30000 | How often to SSH every server |
| `HISTORY_SAMPLES` | 120 | Ring buffer depth per metric (~1h at 30s) |
| `SSH_CONNECT_TIMEOUT_MS` | 5000 | TCP+handshake deadline |
| `SSH_CMD_TIMEOUT_MS` | 4000 | Per-exec deadline |
| `SSH_USER` | bramirezj | Fallback user when `~/.ssh/config` doesn't set one |
| `SSH_KEYS_DIR` | `/home/bramirezj/.ssh` | Where to read `config` + private keys |
| `CLUSTER_SERVERS` | `server-11,server-17,server-18,server-19` | Comma-separated Host aliases |
| `ALERT_ENABLED` | true | Set to `false` to disable Telegram alerts entirely |
| `ALERT_TELEGRAM_BOT_TOKEN` | *(none)* | From `@BotFather`. Required for alerts |
| `ALERT_TELEGRAM_CHAT_ID` | *(none)* | Numeric id of the group/channel the bot posts in |
| `ALERT_DISK_THRESHOLD` | 65 | Filesystem usage % that fires an alert |
| `ALERT_COOLDOWN_MIN` | 60 | Don't re-alert for the same (server, mount) within this many minutes |

## Telegram alerts

The dashboard can send alerts to a Telegram group or channel when:

- a filesystem crosses `ALERT_DISK_THRESHOLD`% (default 65), or
- a server that was responding stops responding (or vice-versa).

Cooldown is per `(server, mount)` for disk alerts, and per `server` for
reachability. A disk at 95% won't re-alert every 30s; it alerts once and
then sits quiet for `ALERT_COOLDOWN_MIN` minutes (default 60).

### Setup (one time)

1. **Create a bot** with [@BotFather](https://t.me/BotFather). Send
   `/newbot`, follow the prompts, and copy the token it gives you.
2. **Add the bot to the group/channel** you want alerts in. Make it an
   admin if the chat is a channel (Telegram requires it for bots to
   post there).
3. **Get the chat id** by sending any message to the group, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read the `chat.id`
   field. For supergroups it will be a negative number starting with
   `-100`; for private messages it will be a positive number.
4. **Create `.env`** in the project root with those two values:

   ```bash
   echo 'ALERT_TELEGRAM_BOT_TOKEN=<your token>' > .env
   echo 'ALERT_TELEGRAM_CHAT_ID=<your chat id>' >> .env
   chmod 600 .env
   ```

   `.env` is git-ignored; the token never lands in git history.

5. **Start the dashboard** with `docker compose up -d`. The first poll
   is silent (no diff to compare against); the second poll is the one
   that can fire alerts.

To turn alerts off later, set `ALERT_ENABLED=false` in the compose
file (or pass `ALERT_ENABLED=false` to the daemon directly).

## Host-side requirements

The dashboard reads the host's SSH config and identity files. You need:

1. `~/.ssh/config` with one `Host <alias>` block per server you want to
   monitor. Each block needs `HostName`, `User`, and `IdentityFile`.
   See your existing `~/.ssh/config` for the working format.
2. The matching identity files (private keys) readable by the user
   the container runs as. The `Dockerfile` defaults to `1000:1000` —
   adjust `BUILD_UID`/`BUILD_GID` if your host user is different.

## Run

```bash
docker compose up -d --build
open http://127.0.0.1:9090
```

## Expose via NPM (optional, not on by default)

The compose file binds to `127.0.0.1:9090` only. If you want to reach
the dashboard from your phone or another network, two safe options:

1. Bind to `0.0.0.0:9090` and put it behind Nginx Proxy Manager with
   Basic Auth (or a passkey via openGym if you build that integration).
2. SSH-tunnel it: `ssh -L 9090:127.0.0.1:9090 user@host` and open
   `http://127.0.0.1:9090` in your local browser.

Do not expose the dashboard to the public internet without auth — it
leaks hostname, distro, kernel version, disk usage, and Docker counts
for every server it sees.

## Security model

- The container reads private keys at runtime. The image contains none.
- The container can exec arbitrary shell on every polled server as
  the configured SSH user. That user should not be `root`. If a server
  has a privileged user with `sudo`, restricting the key with
  `command="..."` in `authorized_keys` is the right move — but for the
  metrics we collect, a non-root user works fine.
- No rate limiting on outgoing SSH. With 4 servers @ 30s that's 8
  outbound auth attempts per minute — well under any fail2ban threshold
  on the remote side.

## License

AGPL-3.0-or-later, same as openGym.