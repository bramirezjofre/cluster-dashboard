# Diagnóstico del crash de `cluster-dashboard` (2026-10-26)

Resumen de la investigación del SIGSEGV / *general protection fault* que
mataba el daemon ~20 veces al día. Se documenta aquí porque el proceso
de descarte es tan informativo como el resultado: la mayor parte de las
hipótesis obvias quedan **descartadas con evidencia**, y eso acota mucho
la búsqueda.

## Síntoma

El proceso `node` del container moría con `exitCode=139` (SIGSEGV).
Docker lo reiniciaba (`restart: unless-stopped`), la UI se caía ~10 s y
volvía. El kernel registraba:

```
node-MainThread[PID]: general protection fault ip:d02368 sp:7fff... error:0 in node[902368,82f000+2c9f000]
node-MainThread[PID]: segfault at 8287d720020 ip 0000760f0a57d4da sp 00007ffde0f77c50 error 4 in node[...]
```

Con `restart: unless-stopped` el servicio nunca queda caído del todo, así
que el impacto era degradación intermitente, no caída total.

## Cómo leer el trap

El trap del kernel da la **dirección virtual absoluta** del instruction
pointer. Para resolverla a un símbolo hace falta el binario con
`debug_info`:

```bash
docker cp cluster-dashboard:/usr/local/bin/node /tmp/node_bin
addr2line -f -C -e /tmp/node_bin 0xd02368
# v8::internal::Object::GetSimpleHash(v8::internal::Object*)
```

El mapping que reporta el trap es `node[902368,82f000+2c9f000]`: base
`0x82f000` y 46 MB de texto. `ip:d02368` cae dentro de ese rango.

**No confundir** `0xd02368` (absoluta) con `0x4d3368` (relativa a la
base): `addr2line` funciona con la absoluta.

## Resultados por crash

| Runtime | Símbolo resuelto | Tipo |
|---|---|---|
| node 22.23.3 (musl) | `cppgc::internal::Sweeper::PerformSweepOnMutatorThread` | GC generacional |
| node 24.20 (musl) | `absl::container_internal::NextSeedBaseNumber()::seed` | semilla de hash |
| node 26.12.1 (glibc) | `v8::internal::Object::GetSimpleHash` | hash de objeto |

Los tres son internos del runtime V8, y los tres con un puntero
corrupto. El desensamblado de `GetSimpleHash` muestra el probe de una
hash table:

```
mov r9,[rdx+rcx*8]   ; leer el bucket
ror r9,0x20          ; mezclar el hash
cmp r9,-1            ; ¿bucket vacío?
```

Es decir: V8 calcula el hash de un objeto y el puntero que lee está
corrupto. **Heap corruption.**

El dato decisivo: el offset `ip:d02368` fue **idéntico** en los dos
últimos crashes (17:38 y 19:01). Un offset reproducible no es
corrupción aleatoria — es un punto de fallo concreto.

## Hipótesis descartadas

| Hipótesis | Cómo se descartó |
|---|---|
| RAM defectuosa | memtester propio (C, 4 patrones: walking ones/zeros, address, random), 8 GB en 2 pasadas → **0 mismatches** |
| musl vs glibc | crashea en Alpine **y** en Debian slim |
| Versión de node | 22.23.x, 24.20 y 26.12.1 fallan igual (V8 12.4 / 13.6 / 14.6) |
| SQLite | `PRAGMA integrity_check` → ok; 120 000 lecturas + DELETE masivo sin crash |
| OOM | heap V8 pequeño, sin OOM kernel |
| `better-sqlite3` con AVX | no usa AVX/AVX2 |
| `ip neigh flush all` | el container no tiene `CAP_NET_ADMIN` (`CapAdd=[]`): el comando falla y se ignora |
| Solo este binario | `python3.14` también dio GPF el 2026-10-26 a las 02:16 y 09:30, misma firma |
| Solo este daemon | `opengym-api-1` (node 22, Alpine) lleva 46 h con **0** crashes; la diferencia es que el dashboard hace SSH + fork masivo |

### Nota sobre la RAM y el watchdog

La RAM es **DDR2 non-ECC** (`Error Correction Type: None`, sin EDAC
funcional). El watchdog reporta `ce=0 ue=0`, pero **eso no prueba
integridad**: es un contador que no está operativo. Solo el memtester
en software da evidencia real, y dio limpio.

## La línea temporal que no encaja

El host hizo reboot el **2026-10-24 20:16** trayendo `systemd 259.5→259.9`,
`docker-ce 29.9.0→29.9.2`, `containerd 2.4.1→2.4.2` y kernel `7.0.0-38`.
Los **primeros** traps de esta serie son del **2026-10-25 19:38** — después
de ese reboot. Antes: 0 traps los días 20, 21, 22, 23 y 24.

El `apt full-upgrade` del 2026-10-26 17:57 (cloud-init, xvfb,
xserver-common, libbrotli1, ubuntu-pro-client) fue **después** de los
crashes de 17:22 y 17:38, así que no los causó.

## Qué sí redujo el problema

`19ac55d` bajó la presión de procesos: el daemon forkeaba **~300 hijos
por minuto** (32 `ping` concurrentes + ~52 lookups `avahi-resolve`/`dig`
+ 5 sesiones SSH). Con `batchSize 32→8` y `concurrency 16→6`, el load
average pasó de **4.85 a 0.02-0.29** en 2 cores, y la frecuencia de
crashes bajó de ~20/día a ~1/hora.

Un fork storm es la forma clásica de exponer un bug de allocator o
kernel latente, así que bajar la carga ataca un **disparador**, aunque
no la causa raíz.

## Cómo observar los traps (importante)

Contarlos con `journalctl --since` **no sirve**: el journal tiene lag de
indexación y el kernel *rate-limita* las señales
(`show_signal_msg: 18 callbacks suppressed`). Un conteo de journal es
como mínimo un piso, no la verdad.

```bash
sudo -n dmesg | grep -cE "segfault at|general protection fault"
```

`dmesg` **requiere sudo**; sin él responde `Operation not permitted`, que
no es lo mismo que "no hay traps". El script de vigilancia
`~/.hermes/scripts/dash_watch.sh` usa esta fuente.

## Commits

| Commit | Qué hace |
|---|---|
| `ee1e772` | `stream.on('error')` en los streams SSH2, handlers de `uncaughtException`/`exit`, timeouts 8 s/10 s, tests de regresión |
| `59f526b` | node 24 (V8 13.6) — intermedio, no resolvió |
| `55268ce` | node 26 sobre Debian slim (glibc), con los paquetes Debian equivalentes verificados uno a uno |
| `19ac55d` | presión de procesos ÷4 (`batchSize 32→8`, `concurrency 16→6`) |
