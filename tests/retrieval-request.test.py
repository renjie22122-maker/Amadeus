import ast, importlib.util, io, json, tempfile, threading, time, unittest
from pathlib import Path
from http.server import BaseHTTPRequestHandler
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('helpers',root/'scripts/rag_request_helpers.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
class Tokenizer:
 model_max_length=24
 def encode(self,text,add_special_tokens=False,**kw):
  # Decoding + re-encoding can expand tokens: exercise the actual prefixed length check.
  return list(text.replace('X','XX'))+(['!','!'] if add_special_tokens else [])
 def decode(self,tokens,**kw):return ''.join(tokens)
class Encoder:
 tokenizer=Tokenizer();max_seq_length=24
class Inputs(unittest.TestCase):
 def test_all_tail_tokens_survive_without_truncation(self):
  w,g,n,stats=h.embedding_windows(Encoder(),['abcdefghijklmnopqrstuv'*5+'TAIL'])
  self.assertTrue(w[-1].endswith('TAIL'));self.assertGreater(len(w),1)
  self.assertLessEqual(stats['maxModelInputTokens'],24);self.assertEqual(n,114)
  self.assertTrue(all(len(Encoder.tokenizer.encode(x,add_special_tokens=True))<=24 for x in w))
 def test_reencoding_expansion_and_prefix_are_counted(self):
  w,g,n,stats=h.embedding_windows(Encoder(),['query: '+'X'*40+'END'])
  self.assertTrue(all(x.startswith('query: ') for x in w));self.assertTrue(w[-1].endswith('END'))
  self.assertLessEqual(stats['maxModelInputTokens'],24)
 def test_empty_and_many_inputs_preserve_grouping(self):
  w,g,n,stats=h.embedding_windows(Encoder(),['','short','last'])
  self.assertEqual(len(g),3);self.assertTrue(all(g));self.assertEqual(n,9)
class Diagnostics(unittest.TestCase):
 def test_deadline_prevents_queued_work_and_releases_lock(self):
  with tempfile.TemporaryDirectory() as tmp:
   d=h.RequestDiagnostics(Path(tmp));d.begin('/embeddings','safe-id',1)
   lock=threading.Lock();d.local.state["start"]-=1
   with self.assertRaises(TimeoutError):
    with d.locked(lock,'inference'):self.fail('expired work ran')
   self.assertFalse(lock.locked());d.finish('deadline_exceeded')
   r=json.loads((Path(tmp)/'requests.jsonl').read_text());self.assertTrue(r['deadlineExceeded'])
 def test_rotation_and_invalid_id(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);(p/'requests.jsonl').write_text('a'*1048576)
   d=h.RequestDiagnostics(p);d.begin('/embeddings','unsafe/token?secret');d.finish('ok')
   self.assertTrue((p/'requests.previous.jsonl').exists())
   r=json.loads((p/'requests.jsonl').read_text());self.assertNotIn('secret',r['requestId'])
class Disconnect(unittest.TestCase):
 def test_broken_response_is_not_retried_as_422(self):
  tree=ast.parse((root/'scripts/retrieval_service.py').read_text())
  handler=next(x for x in tree.body if isinstance(x,ast.ClassDef) and x.name=='Handler')
  env={'BaseHTTPRequestHandler':BaseHTTPRequestHandler,'json':json}
  exec(compile(ast.Module(body=[handler],type_ignores=[]),'handler','exec'),env)
  obj=object.__new__(env['Handler']);calls=[]
  obj.send_response=lambda s:calls.append(s);obj.send_header=lambda *a:None
  obj.end_headers=lambda:None
  class Broken:
   def write(self,b):raise ConnectionAbortedError('peer left')
  obj.wfile=Broken()
  self.assertFalse(obj.send(200,{}));self.assertEqual(calls,[200]);self.assertTrue(obj.close_connection)
class LightDuplicates(unittest.IsolatedAsyncioTestCase):
 async def test_only_exact_processed_original_resolves_duplicate(self):
  from types import SimpleNamespace
  class Values:
   def __init__(self, values): self.values=values
   async def get_by_id(self,key): return self.values.get(key)
  statuses={'a':{'status':'failed','metadata':{'is_duplicate':True,'duplicate_kind':'content_hash','original_doc_id':'b'}},'b':{'status':'processed'}}
  rag=SimpleNamespace(doc_status=Values(statuses),full_docs=Values({'b':{'content':'same'}}))
  self.assertTrue(await h.light_document_complete(rag,'a','same'))
  self.assertTrue(await h.light_document_complete(rag,'a','same\n'))
  self.assertFalse(await h.light_document_complete(rag,'a','different'))
  statuses['b']={'status':'processing'}
  self.assertFalse(await h.light_document_complete(rag,'a','same'))
  statuses['b']=statuses['a']
  self.assertFalse(await h.light_document_complete(rag,'a','same'))
  self.assertFalse(await h.light_document_complete(rag,'missing','same'))

if __name__=='__main__':unittest.main()
