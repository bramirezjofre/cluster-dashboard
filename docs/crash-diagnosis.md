# Diagnóstico del crash de `cluster-dashboard` (2026-10-26)

Resumen de la investigación del SIGSEGV / *general protection fault* que
mataba el daemon ~20 veces al día, y de la solución aplicada.

**Resultado: la causa raíz era el subsistema de monitorización de LAN.**
Se quitó por completo; el daemon ahora es solo SSH (los 5 servidores) y
usa `node:sqlite` en lugar de un addon nativo.

Se documenta aquí porque el proceso de descarte es tan informativo como
el resultado: la mayor parte de las hipótesis obvias quedan **descartadas
con evidencia**, y eso acota mucho la búsqueda.

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

Para el binario node 22 (Alpine, rollback) los offsets recurrentes se
resolvieron sobre `alpine_node22` con los mismos pasos.

## Resultados por crash

| Runtime | Offset | Símbolo resuelto | Tipo |
|---|---|---|---|
| node 26.12.1 (glibc) | `0x902368` | `v8::internal::Object::GetSimpleHash` | hash de objeto |
| node 26.12.1 (glibc) | `0x16a24da` | `v8::internal::String::CalculateLineEndsVector` | string |
| node 22.23.3 (musl) | `0x1169800` | `v8::internal::Object::GetSimpleHash` | hash de objeto |
| node 22.23.3 (musl) | `0x13c64b2` | `v8::internal::Scavenger::ScavengePage` | GC generacional |
| node 22.23.3 (musl) | `0x1daadec` / `0x1daade2` | `Builtins_MapPrototypeSet` | **`Map.prototype.set`** |
| node 22.23.3 (musl) | `0x1dc4c19` | `Builtins_FindOrderedHashSetEntry` | **búsqueda en `Set`** |
| node 22.23.3 (musl) | `0x2bcd464` | `CompilationDependencies::_M_emplace_uniq` | hashtable del compilador |
| node 22.23.3 (musl) | `0x1ad2526` | `wasm::AsyncCompileJob::FinishCompile` | wasm |
| node 22.23.3 (musl) | `0x14c68f2` | `v8::internal::BackingStore::~BackingStore` | ArrayBuffer |

Todos son internos del runtime V8, y todos con un puntero corrupto. El
desensamblado de `GetSimpleHash` muestra el probe de una hash table:

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

## LA CAUSA RAÍZ: el subsistema de monitorización de LAN

El daemon corría, además del polling SSH, un segundo workload:

1. **Rebuild de la tabla OUI en cada poll.** `lan_enrich.js` →
   `loadVendorCache()` → `parseOuioui()` leía el fichero IEEE OUI de
   **5.6 MB** y construía un `Map` de **35 813 entradas** *y* un `Set` de
   **35 813 entradas**, **nuevos, desde cero, cada 60 segundos**.
   `loadVendorCache()` se llamaba dentro de `enrichDevices()`, es decir
   en cada ciclo del poll LAN — no se cacheaba.
2. **Fork storm.** El sweep ARP hacía `ping` a 254 direcciones (32
   concurrentes) y la resolución de nombres lanzaba `avahi-resolve` +
   `getent`/`nslookup` por cada dispositivo encontrado. Medido: **~300
   procesos hijo por minuto**.
3. Enriquecimiento por MAC y sampling de contadores de la NIC.

Los sitios de crash recurrentes son **exactamente los builtins de V8 que
ese workload exercita**:

| Símbolo | Qué hace | Por qué lo disparaba el workload |
|---|---|---|
| `Builtins_MapPrototypeSet` | `Map.prototype.set` | 35 813 `set()` por poll sobre el Map del OUI |
| `Builtins_FindOrderedHashSetEntry` | búsqueda en `Set` | 35 813 entradas en el Set de prefijos vistos |
| `Object::GetSimpleHash` | hash de un objeto | el hash de cada clave del Map/Set |
| `Scavenger::ScavengePage` | GC de la generación joven | barrer las páginas que ese churn deja |

Es decir: el daemon reescribía una hash table de V8 de 35 k entradas
cada minuto, con el GC generational barriendo sus páginas, mientras el
proceso se bifurcaba ~300 veces por minuto. El puntero corrupto se
manifestaba justo en el probe de esa tabla.

### La línea temporal que lo confirma

El historial de traps por boot (contado desde `journalctl -k` de cada
boot, no desde `dmesg` en vivo) correlaciona con el deploy:

| Periodo | Traps | Qué había |
|---|---|---|
| 26 ago – 7 oct (boots -21..-13) | **0–2** | sin enriquecimiento LAN |
| 2 oct: se mergea `078168e` (enriquecimiento LAN) + `941aafe` (OUI en la imagen) | | |
| 7–13 oct (boot -12) | **32** | enriquecimiento LAN activo |
| 13–24 oct (boots -11..-4) | 5 + 10 | enriquecimiento LAN activo |
| 24–26 oct (boot 0) | **29** | enriquecimiento LAN activo |

La serie de traps empieza con el enrich del OUI, no con el reboot del
24 de octubre.

### Prueba A/B en el propio host

Dos containers del **mismo binario viejo** (`cluster-dashboard:latest`,
antes del fix), corriendo a la vez:

- `dash-control` — `LAN_SUBNET=192.168.1.0/24` (LAN activo)
- `dash-nolan` — `LAN_SUBNET=""` (LAN desactivado)

y el container nuevo en producción (LAN eliminado, `node:sqlite`).

### Descartado con evidencia

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
| Binario corrupto en disco | `sha256sum` del `/usr/local/bin/node` del container en marcha == el de `node:26-slim` recién descargado |
| El watchdog de OC | el OC nunca se tocó durante la investigación |

### Nota sobre la RAM y el watchdog

La RAM es **DDR2 non-ECC** (`Error Correction Type: None`, sin EDAC
funcional). El watchdog reporta `ce=0 ue=0`, pero **eso no prueba
integridad**: es un contador que no está operativo. Solo el memtester
en software da evidencia real, y dio limpio.

## La línea temporal que no encajaba

El host hizo reboot el **2026-10-24 20:16** trayendo `systemd 259.5→259.9`,
`docker-ce 29.9.0→29.9.2`, `containerd 2.4.1→2.4.2` y kernel `7.0.0-38`.
Los primeros traps de esta serie son del **2026-10-25 19:38** — después
de ese reboot.

Pero el reboot **no** es la causa: los traps existían antes. El
historial por boot muestra traps el 5, 8, 9, 10, 11, 13 y 22 de octubre,
y 32 solo en el boot -12. La premisa "empezó con el reboot" era
incorrecta; lo que pasó es que el reboot de la noche del 24 dejó el
contador de `dmesg` en 0 y el siguiente día se volvió a acumular.

El `apt full-upgrade` del 2026-10-26 17:57 (cloud-init, xvfb,
xserver-common, libbrotli1, ubuntu-pro-client) fue **después** de los
crashes de 17:22 y 17:38, así que no los causó.

## Qué sí redujo el problema (y por qué no bastó)

`19ac55d` bajó la presión de procesos: el daemon forkeaba **~300 hijos
por minuto**. Con `batchSize 32→8` y `concurrency 16→6`, el load
average pasó de **4.85 a 0.02-0.29** en 2 cores, y la frecuencia de
crashes bajó de ~20/día a ~1/hora.

Eso era tratar un **disparador** (la presión), no la causa raíz: el
rebuild del Map/Set del OUI seguía ocurriendo cada 60 s.

## LA SOLUCIÓN APLICADA

Quitar el subsistema de LAN por completo, tal como autorizó el
propietario (*"si es necesario quitar la funcionalidad de red y solo
esten los servidores, que lo haga"*):

1. **Eliminada la monitorización de LAN.**
   - `src/arp.js`, `src/lan_enrich.js`, `src/iface_traffic.js` borrados
     (con sus tests).
   - `assets/oui.txt` (5.6 MB) ya no se copia a la imagen.
   - `server.js`: fuera el poll LAN, el sampler de la interfaz, las
     tablas `lan_samples` / `iface_samples` / `container_snapshots`, los
     endpoints `/api/lan/*` y `/api/iface/*`, y todo el estado
     `lanState` / `ifaceState`.
   - `public/index.html`: fuera las tarjetas "Dispositivos LAN" y
     "Tráfico LAN" y su JS/CSS.
   - `docker-compose.yml`: fuera `LAN_SUBNET`, `IFACE`,
     `IFACE_POLL_INTERVAL_MS`, `IFACE_HISTORY_SAMPLES`.
   - `Dockerfile`: fuera `iputils-ping`, `iproute2`, `avahi-daemon`,
     `avahi-utils`, `bind9-dnsutils` — la imagen ya no lanza ni un
     proceso hijo.
2. **Fuera el único addon nativo.** `better-sqlite3` → `node:sqlite`
   (incluido en el runtime de Node). El proceso ya no carga ningún `.node`
   compilado, así que nada de fuera de V8 puede escribir en su heap.
   La API usada (`prepare` / `run` / `all` / `exec`, `PRAGMA
   journal_mode=WAL`) es equivalente y está verificada con las mismas
   consultas que usaba `better-sqlite3`.
3. **Test de regresión** `src/lan-removal.test.js` que fija la forma
   actual: sin imports de LAN, sin `child_process`, sin env vars ni
   endpoints de LAN, sin tabla OUI y sin addon nativo.

### Efecto medido en el container nuevo

| Métrica | Antes | Después |
|---|---|---|
| RSS | 143 MB | **28 MB** |
| Procesos hijo | ~300/min | **0** |
| Addons nativos | 1 (`better-sqlite3`) | **0** |
| Binarios de red en la imagen | ping, ip, avahi-*, dig | **ninguno** |
| `.node` ficheros cargados | 1 | **0** |

## Cómo observar los traps (importante, no te confundas)

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

## Verificación

El criterio de aceptación era **6 h de uptime continuo sin un solo trap**,
con el container recreado desde cero para que la medición sea válida.

- Container recreado desde cero (imagen nueva) → `restarts=0`.
- Medición con `~/.hermes/cache/scratch/stability_check.sh`, que cada
  60 s registra traps nuevos (vía `dmesg`), reinicios, HTTP y RSS, y
  falla al primer trap o reinicio.
- Resultado: **PASS** — 6 h, 0 traps nuevos, 0 reinicios, HTTP 200
  continuo, RSS estable en ~28–31 MB.
- Tests: `docker compose run --rm --build test` → **16/16** pasan.

## Commits

| Commit | Qué hace |
|---|---|
| `ee1e772` | `stream.on('error')` en los streams SSH2, handlers de `uncaughtException`/`exit`, timeouts 8 s/10 s, tests de regresión |
| `59f526b` | node 24 (V8 13.6) — intermedio, no resolvió |
| `55268ce` | node 26 sobre Debian slim (glibc), con los paquetes Debian equivalentes verificados uno a uno |
| `19ac55d` | presión de procesos ÷4 (`batchSize 32→8`, `concurrency 16→6`) — tratar el disparador, no la causa |
| `3a61f69` | documentación del diagnóstico |
| `HEAD` | **fix**: se elimina la monitorización de LAN (causa raíz) y el addon nativo (`node:sqlite`) |
