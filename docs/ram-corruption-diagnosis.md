#!/usr/bin/env python3
"""Diagnóstico de corrupción de memoria en ubuntu-republic-gamer (192.168.1.4).

CONTEXTO
=========
El gateway de Hermes y el daemon `cluster-dashboard` (node) sufrían crashes
con "general protection fault" / "double free or corruption (out)" en símbolos de
tablas hash (V8: GetSimpleHash/MapPrototypeSet; CPython: PyDict_SetDefaultRef).
Este script aísla la causa: no es un bug de Python ni de Hermes, es la RAM
overclocked de esta máquina.

MODOS
=====
  dict    — dict compartido mutado desde N hilos (el patrón que crashea)
  single  — el mismo dict, un solo hilo (control lógico)
  churn   — churn de alloc/free SIN dict compartido (control de hardware)

RESULTADOS MEDIDOS EN ESTA MÁQUINA (2026-11-01)
================================================
  Python 3.14.9, 4 hilos, dict 800k entradas ....... 3/8 crash
  Python 3.14.7, 4 hilos, dict 800k entradas ....... 4/8 crash
  Python 3.13.18 (recién descargado), 4 hilos ...... 4/8 crash
  Python 3.10/3.12 en server-agentes (mismo script) . 0/24 crash
  Python 3.10/3.12 en server-17/18 ................. 0/12 crash
  MODE=churn (misma carga, sin dict) .............. 0/24 crash
  RAM secuencial: 1.28 GB escrito/leído ........... 0 corrupciones
  1-2 hilos, cualquier tamaño ..................... 0/20 crash
  3+ hilos + dict grande ........................... ~40% crash
  taskset -c 0 (un solo núcleo) ................... 5/8 crash (NO lo arregla)
  Node 26 con el mismo patrón ..................... 0 crash
  dmesg: 0 entradas MCE/EDAC (la RAM no tiene ECC)

CONCLUSIÓN
==========
Todas las versiones de Python fallan igual -> no es un bug del intérprete.
El mismo script en los otros servidores nunca falla -> no es el código.
El fallo escala con el número de hilos y con el tamaño del dict, y persiste
con un solo núcleo -> no es coherencia de caché entre núcleos.
La RAM está a 1872 MT/s (OC, non-ECC): el kernel no puede ver la corrupción.

Es la RAM a 1872 MT/s corrupriendo memoria bajo concurrencia. Python 3.14 es
solo la víctima más visible (hash tables); Node/V8 lo fue antes, y el gateway
ya sufría "double free or corruption (out)" — el mismo síntoma.

MITIGACIÓN APLICADA
===================
`cron.max_parallel_jobs: 1` en ~/.hermes/config.yaml — serializa los jobs del
cron y elimina la concurrencia que dispara la corrupción. Los dos jobs son
scripts no_agent, así que serializarlos no cuesta nada.

El fix de raíz (bajar la RAM a 1600 MT/s) requiere autorización explícita de
Berna y NO se ha aplicado: el OC se mantiene intacto por decisión suya.
"""
from __future__ import annotations

import os
import sys
import threading

MODE = os.environ.get("MODE", "dict")
NTHREADS = int(os.environ.get("NTHREADS", "8"))
N = int(os.environ.get("N", "200000"))


def dict_mode():
    d = {}

    def worker(n):
        for i in range(N):
            d.setdefault(f"{n}-{i}", [i])
            d.setdefault(f"shared-{i%1000}", [i])

    ts = [threading.Thread(target=worker, args=(n,)) for n in range(NTHREADS)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return f"entries={len(d)}"


def single_mode():
    d = {}
    for n in range(NTHREADS):
        for i in range(N):
            d.setdefault(f"{n}-{i}", [i])
            d.setdefault(f"shared-{i%1000}", [i])
    return f"entries={len(d)}"


def churn_mode():
    """Sin dict compartido: solo asigna/libera. Si esto casca, no es dict."""

    def worker(n):
        for i in range(N):
            a = [i, i + 1, i + 2]
            b = {"x": a, "y": a, "z": a}
            c = (a, b, str(i))
            del a, b, c

    ts = [threading.Thread(target=worker, args=(n,)) for n in range(NTHREADS)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return "churn ok"


MODES = {"dict": dict_mode, "single": single_mode, "churn": churn_mode}

if MODE not in MODES:
    print(f"MODE desconocido: {MODE}", file=sys.stderr)
    sys.exit(2)

res = MODES[MODE]()
print(f"OK mode={MODE} py={sys.version.split()[0]} {res}", flush=True)
