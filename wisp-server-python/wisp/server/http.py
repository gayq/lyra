import asyncio
import pathlib
import mimetypes
import logging
import random
import textwrap

from websockets.server import serve

import wisp
from wisp.server import connection
from wisp.server import ratelimit
from wisp.server import net

static_path = None
default_html = f"""
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width">
    <title>wisp-server-python v{wisp.version}</title>
    <style>
      html {{
        color-scheme: light dark;
      }}
      h1, p {{
        font-family: sans-serif;
      }}
      body {{
        max-width: 600px;
        margin-left: auto;
        margin-right: auto;
      }}
      pre {{
        white-space: pre-wrap
      }}
    </style>
  </head>
  <body>
    <h1>wisp-server-python</h1>
    <p>This is a <a href="https://github.com/MercuryWorkshop/wisp-protocol">Wisp protocol</a> server running
     <a href="https://github.com/MercuryWorkshop/wisp-server-python">wisp-server-python</a> v{wisp.version}.</p>
    <p>This program is licensed under the <a href="https://github.com/MercuryWorkshop/wisp-server-python/blob/main/LICENSE">GNU AGPL v3</a>.</p>
    <pre>
wisp-server-python: a Wisp server implementation written in Python
Copyright (C) 2025 Mercury Workshop

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see &lt;https://www.gnu.org/licenses/&gt;.
</pre>
  </body>
</html>
""".strip()

async def connection_handler(websocket, path):
  client_ip = websocket.remote_address[0]
  if client_ip == "127.0.0.1" and "X-Real-IP" in websocket.request_headers:
    client_ip = websocket.request_headers["X-Real-IP"]
  origin = websocket.request_headers.get("Origin")

  conn_id = "".join(random.choices("1234567890abcdef", k=8))
  logging.info(f"({conn_id}) incoming connection on {path} from {client_ip} (origin: {origin})")
  
  if ratelimit.enabled:
    ratelimit.inc_client_attr(client_ip, "streams")

  if path.endswith("/"):
    wisp_conn = connection.WispConnection(websocket, path, client_ip, conn_id)
    await wisp_conn.setup()
    ws_handler = asyncio.create_task(wisp_conn.handle_ws()) 
    await asyncio.gather(ws_handler)

  else:
    if ratelimit.enabled:
        stream_count = ratelimit.get_client_attr(client_ip, "streams")
        if stream_count > ratelimit.connections_limit:
          return
    wsproxy_conn = connection.WSProxyConnection(websocket, path, client_ip)
    await wsproxy_conn.setup_connection()
    ws_handler = asyncio.create_task(wsproxy_conn.handle_ws())
    tcp_handler = asyncio.create_task(wsproxy_conn.handle_tcp())
    await asyncio.gather(ws_handler, tcp_handler)

async def request_handler(path, request_headers):
  if "Upgrade" in request_headers:
    return
  if not static_path:
    if path.endswith("/") or path.endswith("/index.html"):
      return 200, [("Content-Type", "text/html")], default_html.encode()
    else:
      return 404, [], "404 not found".encode()
    
  response_headers = []
  target_path = static_path / path[1:]

  if target_path.is_dir():
    target_path = target_path / "index.html"
  if not target_path.is_relative_to(static_path):
    return 403, response_headers, "403 forbidden".encode()
  if not target_path.exists():
    return 404, response_headers, "404 not found".encode()
  
  mimetype = mimetypes.guess_type(target_path.name)[0]
  response_headers.append(("Content-Type", mimetype))

  static_data = await asyncio.to_thread(target_path.read_bytes)
  return 200, response_headers, static_data

async def main(args):
  global static_path

  if args.static:
    static_path = pathlib.Path(args.static).resolve()
    mimetypes.init()
  
  if args.limits:
    ratelimit.enabled = True
    ratelimit.connections_limit = int(args.connections)
    ratelimit.bandwidth_limit = float(args.bandwidth)
    ratelimit.window_size = float(args.window)
  
  if args.proxy:
    if args.proxy.startswith("socks5h:"):
      net.proxy_url = args.proxy.replace("socks5h:", "socks5:", 1)
      net.proxy_dns = True
    elif args.proxy.startswith("socks4a:"):
      net.proxy_url = args.proxy.replace("socks4a:", "socks4:", 1)
      net.proxy_dns = True
    else:
      net.proxy_url = args.proxy
      net.proxy_dns = False

  net.block_loopback = not args.allow_loopback
  net.block_private = not args.allow_private
  net.block_udp = args.block_udp
  net.block_tcp = args.block_tcp
      
  limit_task = asyncio.create_task(ratelimit.reset_limits_timer())
  ws_logger = logging.getLogger("websockets")
  ws_logger.setLevel(logging.WARN)

  reuse_port = net.reuse_port_supported()
  server_header = f"wisp-server-python v{wisp.version}"

  async with serve(
    connection_handler, args.host, int(args.port), 
    reuse_port=reuse_port, process_request=request_handler, 
    compression=None, server_header=server_header
  ):
    await asyncio.Future()