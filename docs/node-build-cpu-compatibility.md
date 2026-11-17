# Node build vs. CPU: the v26.12+ SIGSEGV on Pentium E5300

**Symptom.** The daemon dies with exit 139 (SIGSEGV) seconds after start.
Docker restarts it, it dies again, forever. The dashboard is effectively
down and sends no alerts.

**Signature in the kernel log.** The fault is a *general protection
fault*, always at the same offset inside libc, every single time:

```
traps: node-MainThread[51058] general protection fault ip:7be2abd19b65
       sp:7ffd769d22a8 error:0 in libc.so.6[87b65,...]
```

`libc.so.6+0x87b65` resolves to `vsnprintf`. On x86 a GP fault means the
instruction stream is **not legal on this CPU** — not a data race, not a
null pointer, not the app.

**The variable.** The node *build*, and nothing else. Same image, same
Debian glibc, same workload, 8 runs each:

| node build | result |
|---|---|
| v26.12.1 (`node:26-slim`) | 8/8 SIGSEGV (exit 139) |
| v26.8.1 (host binary, same image) | 8/8 OK |

Swapping only the binary — the host's `node` mounted into the container —
flips the outcome. That rules out the image, the libc, the app code, the
Docker setup and the overclock.

**The CPU.** The target host is a Pentium E5300 (Sandy Bridge), which
`gcc -march=native` reports as `core2`: x86-64-v2, with **no AVX, no
AVX2, no BMI2**. The node builds from v26.9 onward ship code that this
CPU cannot execute.

**Where it shows up.** The crash happens during module load — a bare
`require('express')` is enough to abort — which is why the container
never reaches its first poll. The GP fault inside `vsnprintf` is just
where the illegal instruction is first reached.

**The fix.** Pin the base image:

```dockerfile
FROM node:26.8.1-slim
```

Do not use a floating `node:26-slim` tag here: it silently reintroduces
the crash the next time the tag is rebuilt upstream.

**How to re-check before bumping the pin.** Run the same binary in the
same image, several times, and require 0 crashes:

```bash
for i in $(seq 1 8); do
  docker run --rm --entrypoint=node cluster-dashboard:latest \
    -e 'require("express"); console.log("OK")'
done
```

Exit 139 on any run means the build is not safe on this CPU.

**Also fixed here.** `src/notifier.js` assigned a property to a boolean
(`ALERT_ENABLED._warned = true`), which throws
`TypeError: Cannot create property '_warned' on boolean 'true'` on every
poll when the Telegram env vars are missing. It now uses its own
`configWarned` flag. The bug was silent: the alert path was failing on
every single poll while the dashboard still looked healthy.
