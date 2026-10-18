"""Offline protocol concurrency regression; no smolagents/model/container required."""
import ast
import json
from pathlib import Path
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

class ProtocolTest(unittest.TestCase):
 def test_parallel_calls_do_not_exchange_replies(self):
  tree=ast.parse(Path(__file__).with_name('native-smol.py').read_text())
  functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('rpc','rpc_exchange')]
  class Wire:
   pending=None
   def write(self,text):
    if not text.strip():return
    if self.pending is not None:raise AssertionError('overlapping RPC exchange')
    self.pending=json.loads(text)['value']
   def flush(self):pass
   def readline(self):
    time.sleep(.002)
    value=self.pending;self.pending=None
    return json.dumps({'result':value})+'\n'
  wire=Wire();scope=dict(json=json,protocol_out=wire,protocol_in=wire,rpc_lock=threading.Lock())
  exec(compile(ast.Module(body=functions,type_ignores=[]),'rpc-test','exec'),scope)
  with ThreadPoolExecutor(max_workers=8) as pool:
   answers=list(pool.map(lambda i:scope['rpc']('test',value=i),range(40)))
  self.assertEqual(answers,list(range(40)))
if __name__=='__main__':unittest.main()
