import asyncio
import socket
import ipaddress

import asyncudp
from python_socks.async_.asyncio import Proxy

tcp_size = 524288
block_loopback = False
block_private = False
block_udp = False
block_tcp = False

proxy_url = None
proxy_dns = False

def reuse_port_supported():
  return hasattr(socket, "SO_REUSEPORT")

def is_ip(addr_str):
  try:
    ipaddress.ip_address(addr_str)
    return True
  except:
    return False

def get_ip(host, port, stream_type):
  if stream_type == 0x01:
    proto = socket.IPPROTO_TCP
  else:
    proto = socket.IPPROTO_UDP
  info = socket.getaddrinfo(host, port, proto=proto)
  return info[0][4][0]

async def get_ip_async(host, port, stream_type):
  loop = asyncio.get_running_loop()
  return await loop.run_in_executor(None, get_ip, host, port, stream_type)

def validate_ip(addr_str):  
  ip_addr = ipaddress.ip_address(addr_str)
  if block_loopback and ip_addr.is_loopback:
    raise TypeError("Connection to loopback ip address blocked.")
  if block_private and ip_addr.is_private and not ip_addr.is_loopback:
    raise TypeError("Connection to private ip address blocked.")

async def validate_hostname(host, port, stream_type):
  if is_ip(host):
    validate_ip(host)
    return host
  elif proxy_url and proxy_dns:
    return None
  else:  
    addr_str = await get_ip_async(host, port, stream_type)
    validate_ip(addr_str)
    return addr_str

class TCPConnection:
  def __init__(self, hostname, port):
    self.hostname = hostname
    self.port = port
    self.tcp_writer = None
    self.tcp_reader = None
  
  async def connect(self):
    if block_tcp:
      raise TypeError("TCP connection blocked.")

    addr_str = await validate_hostname(self.hostname, self.port, 0x01)
    if proxy_url:
      proxy = Proxy.from_url(proxy_url, rdns=proxy_dns)
      proxy_dest = self.hostname if proxy_dns else addr_str
      sock = await proxy.connect(dest_host=proxy_dest, dest_port=self.port)
      self.tcp_reader, self.tcp_writer = await asyncio.open_connection(
        limit=tcp_size, 
        sock=sock
      )
    else:
      self.tcp_reader, self.tcp_writer = await asyncio.open_connection(
        host=addr_str, 
        port=self.port,
        limit=tcp_size,
      )
  
  async def recv(self):
    return await self.tcp_reader.read(tcp_size)
  
  async def send(self, data):
    self.tcp_writer.write(data)
    await self.tcp_writer.drain() 
  
  def close(self):
    if self.tcp_writer is None:
      return
    if self.tcp_writer.is_closing():
      return
    self.tcp_writer.close()

class UDPConnection:
  def __init__(self, hostname, port):
    self.hostname = hostname
    self.port = port
    self.socket = None
  
  async def connect(self):
    if block_udp:
      raise TypeError("UDP connection blocked.")
    if proxy_url:
      raise NotImplementedError("SOCKS/HTTP proxy is not supported for UDP.")

    addr_str = await validate_hostname(self.hostname, self.port, 0x02)
    self.socket = await asyncudp.create_socket(remote_addr=(addr_str, self.port))
  
  async def recv(self):
    data, addr = await self.socket.recvfrom()
    return data
  
  async def send(self, data):
    self.socket.sendto(data)
  
  def close(self):
    if self.socket is None:
      return
    self.socket.close()