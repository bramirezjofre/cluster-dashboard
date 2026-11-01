#!/usr/bin/env python3
"""Discrimina software (bug de dict en CPython 3.14) de hardware (RAM/OC).

Cuatro modos:
  dict      — dict compartido mutado desde N hilos (el caso que crashea Hermes)
  single    — el mismo dict, un solo hilo (control logico)
  churn     — solo churn de asignacion/liberacion de objetos, SIN dict compartido
  malloc    — churn con PYTHONMALLOC=malloc (desactiva pymalloc)
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
    """Sin dict compartido: solo asigna/libera listas. Si esto tambien casca, no es dict."""
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
