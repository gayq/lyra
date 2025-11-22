import importlib.metadata

def get_version():
  try:
    return importlib.metadata.version("wisp-python")
  except TypeError:
    return "0.0.0"