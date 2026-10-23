#!/usr/bin/env python3

import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time


def snapshot(source, destination, timeout=300):
    source = Path(source).resolve(strict=True)
    destination = Path(destination).absolute()
    if source == destination.resolve():
        raise ValueError("backup destination matches source... /ᐠ - ˕ -マ")
    deadline = time.monotonic() + timeout

    def progress(*_):
        if time.monotonic() >= deadline:
            raise TimeoutError("backup deadline exceeded... /ᐠ - ˕ -マ")

    descriptor, temporary = tempfile.mkstemp(prefix=".cloudsync-", dir=destination.parent)
    os.close(descriptor)
    try:
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5) as src:
            with sqlite3.connect(temporary) as dst:
                src.backup(dst, pages=256, progress=progress, sleep=0.05)
                dst.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10_000)
                if dst.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise ValueError("backup verification failed... /ᐠ - ˕ -マ")
        with open(temporary, "rb") as result:
            os.fsync(result.fileno())
        os.replace(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: cloudsync-backup.py source destination", file=sys.stderr)
        sys.exit(2)
    try:
        snapshot(sys.argv[1], sys.argv[2])
    except (OSError, sqlite3.Error, ValueError):
        print("database backup failed... /ᐠ - ˕ -マ", file=sys.stderr)
        sys.exit(1)
    print("database snapshot saved!! (˵◝ ⩊  ◜˵マ")
