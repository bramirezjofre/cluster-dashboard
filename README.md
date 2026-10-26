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
- Stores long-term history in SQLite (inside the `cluster-dashboard-data`
  volume) so it survives container restarts. Uses Node's built-in
  `node:sqlite`, so the daemon loads **no native addon** at all

## What it does NOT do

- It does not modify the remote servers — no install, no agent, no
  persistent daemon on them. Every metric is collected via one SSH exec
  per poll per server.
- It does not store credentials. The container reads SSH identity files
  mounted read-only from the host; no keys are baked into the image.
- It does not persist history to disk. A restart loses the ring buffer;
  that's intentional for a single-host dashboard.

## LAN monitoring (removed on 2026-10-26)

The dashboard used to have a second panel that tracked the local network:
an **ARP scan** of `LAN_SUBNET` with **vendor** (MAC OUI) and **hostname**
(mDNS / reverse DNS) enrichment for every device found, plus
**interface traffic** counters (rx/tx Kbps) for the host's LAN NIC.

**That feature has been removed.** It was the trigger for a crash that
killed the daemon with SIGSEGV / "general protection fault" (exit 139) up
to ~20 times a day, always inside V8's hash-table / GC internals with a
corrupted pointer. The full evidence trail is in
[`docs/crash-diagnosis.md`](docs/crash-diagnosis.md); the short version:

- The OUI table (5.6 MB, 35 813 prefixes) was re-parsed into a fresh
  35 813-entry `Map` **and** a 35 813-entry `Set` on *every* 60 s poll.
  The recurring crash sites were precisely the V8 builtins that workload
  exercises: `Builtins_MapPrototypeSet`, `Builtins_FindOrderedHashSetEntry`,
  `Object::GetSimpleHash` and `Scavenger::ScavengePage`.
- On top of that the daemon forked ~300 child processes per minute
  (254 `ping` calls for the ARP sweep, ~52 `avahi-resolve`/`dig`/`getent`
  lookups).
- It reproduced on node 22, 24 and 26, on musl and glibc, in the
  container and natively on the host — so it was not a runtime-version
  bug, not a libc bug, and not the overclock.

The owner authorised dropping the network functionality outright
("*si es necesario quitar la funcionalidad de red y solo esten los
servidores, que lo haga*"). The daemon is now **SSH-only**: the five
servers over SSH are the core feature and they are untouched.

### What was lost

| Removed | Consequence |
|---|---|
| "Dispositivos LAN" card | No list of active LAN hosts, their MACs, vendors or hostnames |
| "Tráfico LAN" card | No rx/tx Kbps sparkline for the host's LAN NIC |
| `/api/lan/status`, `/api/lan/history` | Endpoints removed |
| `/api/iface/status`, `/api/iface/history` | Endpoints removed |
| `LAN_SUBNET`, `IFACE`, `IFACE_POLL_INTERVAL_MS`, `IFACE_HISTORY_SAMPLES` | Env vars removed from `docker-compose.yml` |
| `src/arp.js`, `src/lan_enrich.js`, `src/iface_traffic.js` | Source modules deleted |
| `assets/oui.txt` (5.6 MB) | IEEE OUI database no longer shipped in the image |

The SQLite database keeps its `lan_samples` and `iface_samples` tables in
older volumes; the daemon simply stops writing to them.

### If you want it back

Do **not** bring it back the way it was. The per-poll rebuild of a
35 k-entry `Map`/`Set` is what crashed the daemon, and the fork-per-
address sweep is what turned it into a fork storm. If the LAN panel is
ever wanted again:

1. Parse the OUI table **once** at startup and keep the `Map` in memory.
   Never rebuild it per poll.
2. Use a single batched `ip neigh` read instead of pinging all 254
   addresses, and do the name lookups with one bounded worker pool
   instead of two forks per device.
3. Keep the whole thing off the critical path: the SSH polling is the
   feature that matters, and it must never share a process with a
   workload that can corrupt the heap.

`src/lan-removal.test.js` asserts the current shape so the LAN workload
cannot creep back in unnoticed.

## Tests

A standalone test image (`Dockerfile.test`) runs the unit tests on
Node 26-alpine, which avoids polluting the host's `node_modules` and
matches the runtime version used in production:

```bash
docker build -f Dockerfile.test -t cluster-dashboard-test .
docker run --rm cluster-dashboard-test
```

Or via Compose, using the `test` profile so `docker compose up` doesn't
start it:

```bash
docker compose run --rm test
```

The test suite currently covers:

- `src/ssh-error-handling.test.js` — the ssh2 stream-error regression:
  a late `error` on an exec stream must not kill the daemon.
- `src/lan-removal.test.js` — the LAN subsystem stays out: no `arp.js` /
  `lan_enrich.js` / `iface_traffic.js` imports, no `child_process`, no
  LAN env vars or API endpoints, no OUI table, and no native addon
  (`node:sqlite` instead of `better-sqlite3`).

Tests use `node --test`, no extra dependencies.

## Layout

```
cluster-dashboard/
├── Dockerfile
├── Dockerfile.test
├── docker-compose.yml
├── package.json
├── docs/crash-diagnosis.md  # why the LAN panel was removed (SIGSEGV)
├── src/server.js          # daemon: ssh poll loop + JSON API + static serve
├── src/notifier.js        # telegram alerts
└── public/index.html      # frontend: cards + sparklines + auto-refresh
```

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `PORT` | 9090 | HTTP listen port inside the container |
| `POLL_INTERVAL_MS` | 30000 | How often to SSH every server |
| `HISTORY_SAMPLES` | 120 | Ring buffer depth per metric (~1h at 30s) |
| `SSH_CONNECT_TIMEOUT_MS` | 8000 | TCP+handshake deadline |
| `SSH_CMD_TIMEOUT_MS` | 10000 | Per-exec deadline (must be >= connect timeout) |
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