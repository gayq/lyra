import asyncio
import argparse
import pathlib
import sys
import logging
import multiprocessing
import threading
import platform

try:
  import concurrent.interpreters
  has_subinterpreters = True
except ImportError:
  has_subinterpreters = False

try:
  import uvloop
  event_loop = "uvloop"
except ImportError:
  try:
    import winloop
    event_loop = "winloop"
  except ImportError:
    event_loop = "asyncio"

import wisp
from wisp.server import http 
from wisp.server import net

def run_async(func, *args, **kwargs):
  try:
    if event_loop == "uvloop":
      uvloop.run(func(*args, **kwargs))
    elif event_loop == "winloop":
      winloop.run(func(*args, **kwargs))
    else:
      asyncio.run(func(*args, **kwargs))
  except KeyboardInterrupt:
    pass

def run_http(args):
  run_async(http.main, args)

def run_processes(thread_count, args):
  processes = []
  for i in range(0, int(thread_count)):
    process = multiprocessing.Process(target=run_http, args=(args,), daemon=True)
    processes.append(process)
    process.start()
  try:
    for process in processes:
      process.join()
  except KeyboardInterrupt:
    pass

def run_subinterpreters(thread_count, args):
  def thread_func():
    interpreter = concurrent.interpreters.create()
    interpreter.call(run_http, args)
    
  threads = []
  for i in range(0, int(thread_count)):
    thread = threading.Thread(target=thread_func, daemon=True)
    threads.append(thread)
    thread.start()
  try:
    for thread in threads:
      thread.join()
  except KeyboardInterrupt:
    pass

def main():
  parser = argparse.ArgumentParser(
    prog="wisp-server-python",
    description=f"A Wisp server implementation, written in Python (v{wisp.version})"
  )

  parser.add_argument("--host", default="127.0.0.1", help="The hostname the server will listen on.")
  parser.add_argument("--port", default=6001, help="The TCP port the server will listen on.")
  parser.add_argument("--static", help="Where static files are served from.")
  parser.add_argument("--limits", action="store_true", help="Enable rate limits.")
  parser.add_argument("--bandwidth", default=1000, help="Bandwidth limit per IP, in kilobytes per second.")
  parser.add_argument("--connections", default=30, help="New connections limit per IP.")
  parser.add_argument("--window", default=60, help="Fixed window length for rate limits, in seconds.")
  parser.add_argument("--allow-loopback", action="store_true", help="Allow connections to loopback IP addresses.")
  parser.add_argument("--allow-private", action="store_true", help="Allow connections to private IP addresses.")
  parser.add_argument("--log-level", default="info", help="The log level (either debug, info, warning, error, or critical).")
  parser.add_argument("--threads", default=0, help="The number of threads to run the server on. By default it uses all CPU cores. (Linux only)")
  parser.add_argument("--proxy", default=None, help="The url of the socks5h, socks5, sock4a, socks4 or http proxy to use.")
  parser.add_argument("--block-udp", action="store_true", help="Block UDP streams.")
  parser.add_argument("--block-tcp", action="store_true", help="Block TCP streams.")
  args = parser.parse_args()

  logging.basicConfig(
    format="[%(asctime)s] %(levelname)-8s %(message)s",
    level=getattr(logging, args.log_level.upper()),
    datefmt="%Y/%m/%d - %H:%M:%S"
  )

  logging.info(f"running wisp-server-python v{wisp.version} (async)")
  if args.static:
    static_path = pathlib.Path(args.static).resolve()
    logging.info(f"serving static files from {static_path}")
  if args.limits:
    logging.info("enabled rate limits")
  if args.proxy:
    logging.info(f"proxy enabled: {args.proxy}")
  logging.info(f"running on {platform.python_implementation()} {platform.python_version()}")
  logging.info(f"listening on {args.host}:{args.port}")

  if event_loop == "asyncio":
    logging.error("failed to import uvloop or winloop. falling back to asyncio, which is slower.")

  threads = int(args.threads)
  if net.reuse_port_supported():
    if threads == 0:
      threads = multiprocessing.cpu_count()
    logging.info(f"running using {threads} threads")
    
    if has_subinterpreters:
      run_subinterpreters(threads, args);
    else:
      run_processes(threads, args)
  
  else:
    if threads != 0:
      logging.warn("the --threads option is not supported on this platform")
    run_http(args)