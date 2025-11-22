import asyncio
import struct
import os
import logging

from websockets.exceptions import ConnectionClosed

from wisp.server import ratelimit
from wisp.server import net

queue_size = 1024
static_path = None

packet_format = "<BI"
connect_format = "<BH"
continue_format = "<I"
close_format = "<B"

class WSProxyConnection:
  def __init__(self, ws, path, client_ip):
    self.ws = ws
    self.path = path
    self.client_ip = client_ip

  async def setup_connection(self):
    addr_str = self.path.split("/")[-1]
    self.tcp_host, self.tcp_port = addr_str.split(":")
    self.tcp_port = int(self.tcp_port)

    try:
      self.conn = net.TCPConnection(self.tcp_host, self.tcp_port)
      await self.conn.connect()
    except Exception as e:
      logging.warning(f"Creating a WSProxy stream to {self.tcp_host}:{self.tcp_port} failed: {e}")
      await self.ws.close()

  async def handle_ws(self):
    while True:
      try:
        data = await self.ws.recv()
      except ConnectionClosed:
        break

      if ratelimit.enabled:
        await ratelimit.limit_client_bandwidth(self.client_ip, len(data), "ws")
      await self.conn.send(data)
    
    self.conn.close()
  
  async def handle_tcp(self):
    while True:
      data = await self.conn.recv()
      if not data:
        break

      if ratelimit.enabled:
        await ratelimit.limit_client_bandwidth(self.client_ip, len(data), "tcp")
      await self.ws.send(data)
    
    await self.ws.close()

class WispConnection:
  def __init__(self, ws, path, client_ip, id=None):
    self.ws = ws
    self.path = path
    self.active_streams = {}
    self.client_ip = client_ip
    self.id = id
  
  async def setup(self):
    continue_payload = struct.pack(continue_format, queue_size)
    continue_packet = b''.join((struct.pack(packet_format, 0x03, 0), continue_payload))
    await self.ws.send(continue_packet)

  async def new_stream(self, stream_id, payload):
    view = memoryview(payload)
    stream_type, destination_port = struct.unpack(connect_format, view[:3])
    hostname = str(view[3:], 'utf-8')
    
    if logging.getLogger().isEnabledFor(logging.DEBUG):
        logging.debug(f"({self.id}) Creating a new stream to {hostname}:{destination_port}")

    if ratelimit.enabled:
      stream_count = ratelimit.get_client_attr(self.client_ip, "streams")
      if stream_count > ratelimit.connections_limit:
        await self.send_close_packet(stream_id, 0x49)
        self.close_stream(stream_id)
        return
    
    try:
      if stream_type == 0x01:
        connection = net.TCPConnection(hostname, destination_port)
      elif stream_type == 0x02: 
        connection = net.UDPConnection(hostname, destination_port)
      else:
        raise Exception("Invalid stream type.")
      self.active_streams[stream_id]["conn"] = connection
      await connection.connect()
        
    except Exception as e:
      if logging.getLogger().isEnabledFor(logging.WARNING):
          logging.warning(f"({self.id}) Creating a new stream to {hostname}:{destination_port} failed: {e}")
      await self.send_close_packet(stream_id, 0x42)
      self.close_stream(stream_id)
      return
    
    self.active_streams[stream_id]["type"] = stream_type
    ws_to_tcp_task = asyncio.create_task(self.task_wrapper(self.stream_ws_to_tcp, stream_id))
    tcp_to_ws_task = asyncio.create_task(self.task_wrapper(self.stream_tcp_to_ws, stream_id))
    self.active_streams[stream_id]["ws_to_tcp_task"] = ws_to_tcp_task
    self.active_streams[stream_id]["tcp_to_ws_task"] = tcp_to_ws_task

    if ratelimit.enabled:
      ratelimit.inc_client_attr(self.client_ip, "streams")
  
  async def task_wrapper(self, target_func, *args, **kwargs):
    try:
      await target_func(*args, **kwargs)
    except asyncio.CancelledError as e:
      raise e
        
  async def stream_ws_to_tcp(self, stream_id):
    stream = self.active_streams[stream_id]
    conn = stream["conn"]
    queue = stream["queue"]
    
    while True: 
      data = await queue.get()
      try:
        await conn.send(data)
      except:
        break

      stream["packets_sent"] += 1
      if stream["packets_sent"] & 0xFF == 0:
        buffer_remaining = queue.maxsize - queue.qsize()
        continue_payload = struct.pack(continue_format, buffer_remaining)
        continue_packet = b''.join((struct.pack(packet_format, 0x03, stream_id), continue_payload))
        await self.ws.send(continue_packet)
  
  async def stream_tcp_to_ws(self, stream_id):
    stream = self.active_streams[stream_id]
    conn = stream["conn"]
    header = struct.pack(packet_format, 0x02, stream_id)
    
    while True:
      try:
        data = await conn.recv()
      except Exception as e:
        logging.warning(f"({self.id}) Receiving data from stream failed: {e}")
        await self.send_close_packet(stream_id, 0x03)
        self.close_stream(stream_id)
        return
        
      if not data: 
        break
      
      if ratelimit.enabled:
        await ratelimit.limit_client_bandwidth(self.client_ip, len(data) + 5, "tcp")

      await self.ws.send(b''.join((header, data)))

    await self.send_close_packet(stream_id, 0x02)
    self.close_stream(stream_id)
  
  async def send_close_packet(self, stream_id, reason):
    if stream_id not in self.active_streams:
      return
    close_payload = struct.pack(close_format, reason)
    close_packet = b''.join((struct.pack(packet_format, 0x04, stream_id), close_payload))
    await self.ws.send(close_packet)
  
  def close_stream(self, stream_id):
    if stream_id not in self.active_streams:
      return 
    stream = self.active_streams[stream_id]
    if stream["conn"]:
      stream["conn"].close()

    if not stream["connect_task"].done():
      stream["connect_task"].cancel() 
    if stream["ws_to_tcp_task"] is not None and not stream["ws_to_tcp_task"].done():
      stream["ws_to_tcp_task"].cancel()
    if stream["tcp_to_ws_task"] is not None and not stream["tcp_to_ws_task"].done():
      stream["tcp_to_ws_task"].cancel()
    
    del self.active_streams[stream_id]
  
  async def handle_ws(self):
    while True:
      try:
        data = await self.ws.recv()
      except ConnectionClosed:
        break
      except Exception as e:
        logging.warning(f"({self.id}) Receiving data from websocket failed: {e}")
        break

      if not isinstance(data, bytes): 
        continue 
      
      if ratelimit.enabled:
        await ratelimit.limit_client_bandwidth(self.client_ip, len(data), "ws")
      
      view = memoryview(data)
      packet_type, stream_id = struct.unpack(packet_format, view[:5])
      payload = view[5:]

      if packet_type == 0x01: 
        connect_task = asyncio.create_task(self.task_wrapper(self.new_stream, stream_id, payload))
        self.active_streams[stream_id] = {
          "conn": None,
          "type": None,
          "queue": asyncio.Queue(queue_size),
          "connect_task": connect_task,
          "ws_to_tcp_task": None,
          "tcp_to_ws_task": None,
          "packets_sent": 0
        }
      
      elif packet_type == 0x02: 
        stream = self.active_streams.get(stream_id)
        if not stream:
          continue
        try:
          stream["queue"].put_nowait(payload)
        except asyncio.QueueFull:
          await stream["queue"].put(payload)
      
      elif packet_type == 0x04: 
        reason = struct.unpack(close_format, payload)[0]
        self.close_stream(stream_id)
  
    for stream_id in list(self.active_streams.keys()):
      self.close_stream(stream_id)