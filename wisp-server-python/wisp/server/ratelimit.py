import asyncio
import time

active_clients = {}
enabled = False

connections_limit = 30
bandwidth_limit = 100
window_size = 60

def init_client(client_ip):
  if client_ip not in active_clients:
    active_clients[client_ip] = {
      "streams": 0, 
      "tcp": 0, 
      "ws": 0, 
      "start": time.time()
    }

def get_client_attr(client_ip, attr):
  if client_ip not in active_clients:
    init_client(client_ip)
  return active_clients[client_ip][attr]

def set_client_attr(client_ip, attr, value):
  if client_ip not in active_clients:
    init_client(client_ip)
  active_clients[client_ip][attr] = value

def inc_client_attr(client_ip, attr, amount=1):
  if client_ip not in active_clients:
    init_client(client_ip)
  active_clients[client_ip][attr] += amount

def calculate_client_bandwidth(client_ip, attr):
  start_time = active_clients[client_ip]["start"]
  total_data = active_clients[client_ip][attr]
  now = time.time()
  return total_data / (now - start_time) / 1000

async def limit_client_bandwidth(client_ip, length, attr):
  if not enabled: return
  
  if client_ip not in active_clients:
    init_client(client_ip)
  
  active_clients[client_ip][attr] += length
  
  start_time = active_clients[client_ip]["start"]
  while (active_clients[client_ip][attr] / (time.time() - start_time) / 1000) > bandwidth_limit:
    await asyncio.sleep(0.01)

async def reset_limits_timer():
  global active_clients
  while True:
    active_clients = {}
    await asyncio.sleep(window_size)

def limit_client_bandwidth_sync(client_ip, length, attr):
  if not enabled: return
  inc_client_attr(client_ip, attr, length)
  while calculate_client_bandwidth(client_ip, attr) > bandwidth_limit:
    time.sleep(0.01)

def reset_limits_timer_sync():
  global active_clients
  while True:
    active_clients = {}
    time.sleep(window_size)