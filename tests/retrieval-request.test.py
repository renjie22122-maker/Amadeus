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

 async def test_generated_duplicate_id_is_resolved_only_with_matching_source_and_content(self):
  from types import SimpleNamespace
  class Values:
   async def get_by_id(self,key):return {'status':'processed'} if key=='original' else None
   async def get_doc_by_file_path(self,source):return self.row
  statuses=Values();statuses.row={'file_path':'source-a','status':'failed','metadata':{'is_duplicate':True,'duplicate_kind':'content_hash','original_doc_id':'original'}}
  class Docs:
   async def get_by_id(self,key):return {'content':'same'}
  rag=SimpleNamespace(doc_status=statuses,full_docs=Docs())
  self.assertTrue(await h.light_document_complete(rag,'missing','same','source-a'))
  self.assertFalse(await h.light_document_complete(rag,'missing','other','source-a'))
  self.assertFalse(await h.light_document_complete(rag,'missing','same','source-b'))
  statuses.row['metadata']['duplicate_kind']='filename'
  self.assertFalse(await h.light_document_complete(rag,'missing','same','source-a'))

class SharedTokenizerConcurrency(unittest.TestCase):
 def test_concurrent_graph_embeddings_query_windows_and_rerank(self):
  from concurrent.futures import ThreadPoolExecutor
  from types import SimpleNamespace
  tree=ast.parse((root/'scripts/retrieval_service.py').read_text(encoding='utf-8'))
  lock=threading.RLock(); access=threading.Lock()
  class SharedTokenizer:
   model_max_length=512
   def touch(self,value):
    if not access.acquire(blocking=False):raise RuntimeError('Already borrowed')
    try:time.sleep(.001);return value
    finally:access.release()
   def encode(self,text,**kw):return self.touch(list(text))
   def decode(self,tokens,**kw):return self.touch(''.join(tokens))
   def __call__(self,pairs,**kw):return self.touch({'length':[len(a)+len(b) for a,b in pairs]})
  class Model:
   tokenizer=SharedTokenizer();max_seq_length=512
   model=SimpleNamespace(config=SimpleNamespace(max_position_embeddings=512))
   def encode(self,texts,**kw):return self.tokenizer.encode(' '.join(texts))
   def predict(self,pairs,**kw):self.tokenizer(pairs);return [0.5]*len(pairs)
  with tempfile.TemporaryDirectory() as tmp:
   env={'LOCK':lock,'DIAGNOSTICS':h.RequestDiagnostics(Path(tmp)),'model':lambda _:Model(),'embedding_windows':h.embedding_windows,'torch':SimpleNamespace(nn=SimpleNamespace(Sigmoid=lambda:None))}
   for name in ('embeddings','rerank'):
    fn=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name==name)
    fn.body=[x for x in fn.body if not isinstance(x,ast.Import)]
    if name=='embeddings':
     end=next(i for i,x in enumerate(fn.body) if isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='values' for t in x.targets))
     fn.body=fn.body[:end]+[ast.Return(value=ast.Name(id='batches',ctx=ast.Load()))]
    exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'actual-service-functions','exec'),env)
   create=next(x for x in tree.body if isinstance(x,ast.AsyncFunctionDef) and x.name=='create_rag')
   cls=next(x for x in create.body if isinstance(x,ast.ClassDef) and x.name=='LocalTokenizer')
   exec(compile(ast.Module(body=[cls],type_ignores=[]),'actual-local-tokenizer','exec'),env)
   def task(i):
    for _ in range(8):
     if i%3==0:env['embeddings'](['passage: graph entity text'*30])
     elif i%3==1:env['embeddings'](['query: retrieval query'])
     else:
      t=env['LocalTokenizer']();t.decode(t.encode('graph chunking'))
      env['rerank']({'query':'query','texts':['candidate']})
   with ThreadPoolExecutor(max_workers=9) as pool:list(pool.map(task,range(9)))

class LightResume(unittest.IsolatedAsyncioTestCase):
 async def test_recovery_preserves_complete_and_rejects_changed_or_unrelated_records(self):
  import hashlib
  from types import SimpleNamespace
  sources=['amadeus-a','amadeus-b'];texts=['one','two']
  ids=['doc-'+hashlib.sha256((a+b).encode()).hexdigest() for a,b in zip(sources,texts)]
  rows={ids[0]:{'status':'processed','file_path':sources[0]},ids[1]:{'status':'failed','file_path':sources[1]}}
  docs={ids[0]:{'content':'one'},ids[1]:{'content':'two'}}
  class Values:
   def __init__(self,d):self.d=d
   async def get_by_id(self,k):return self.d.get(k)
   async def get_docs_by_statuses(self,statuses,**kw):
    values={s.value for s in statuses}
    return {k:v for k,v in self.d.items() if v.get('status') in values}
  rag=SimpleNamespace(doc_status=Values(rows),full_docs=Values(docs))
  plan=await h.light_resume_plan(rag,texts,sources)
  self.assertEqual(plan,{'completed':[ids[0]],'pending':[ids[1]]})
  docs[ids[1]]['content']='changed'
  with self.assertRaises(ValueError):await h.light_resume_plan(rag,texts,sources)
  docs[ids[1]]['content']='two';rows['unrelated']={'status':'failed'}
  with self.assertRaises(ValueError):await h.light_resume_plan(rag,texts,sources)
  self.assertEqual(rows[ids[0]]['status'],'processed')

class RecoveryEndpoint(unittest.TestCase):
 def test_explicit_digest_bound_resume_is_single_and_not_an_auto_retry(self):
  import hashlib,hmac
  from types import SimpleNamespace
  original={'scope':'test','texts':['text'],'file_sources':['amadeus-source']}
  key=hashlib.sha256(json.dumps(original,sort_keys=True).encode()).hexdigest()
  jobs={key:{'status':'unknown'}};submitted=[]
  tree=ast.parse((root/'scripts/retrieval_service.py').read_text(encoding='utf-8'));handler=next(x for x in tree.body if isinstance(x,ast.ClassDef) and x.name=='Handler')
  with tempfile.TemporaryDirectory() as tmp:
   env={'BaseHTTPRequestHandler':BaseHTTPRequestHandler,'json':json,'hmac':hmac,'hashlib':hashlib,'TOKEN':'x'*32,'DIAGNOSTICS':h.RequestDiagnostics(Path(tmp)),'JOBS':jobs,'JOB_LOCK':threading.RLock(),'save_jobs':lambda:None,'POOL':SimpleNamespace(submit=lambda *a:submitted.append(a)),'run_job':lambda:None}
   exec(compile(ast.Module(body=[handler],type_ignores=[]),'actual-handler','exec'),env)
   def request(body):
    raw=json.dumps(body).encode();obj=object.__new__(env['Handler']);obj.path='/lightrag/documents/resume';obj.headers={'Authorization':'Bearer '+'x'*32,'Content-Length':str(len(raw))};obj.rfile=io.BytesIO(raw);obj.connection=SimpleNamespace(settimeout=lambda _:None);out=[];obj.send=lambda status,data:out.append((status,data)) or True;obj.do_POST();return out[-1]
   self.assertEqual(request({'jobId':key,'original':original})[0],422)
   self.assertEqual(request({'jobId':key,'original':{**original,'texts':['changed']},'confirmRetry':True})[0],422)
   self.assertEqual(len(submitted),0)
   body={'jobId':key,'original':original,'confirmRetry':True}
   self.assertEqual(request(body)[0],200);self.assertEqual(request(body)[0],200)
   self.assertEqual(len(submitted),1);self.assertTrue(submitted[0][-1])
   jobs[key]={'status':'completed'};self.assertEqual(request(body)[0],200);self.assertEqual(len(submitted),1)


class LiveGraphProgress(unittest.IsolatedAsyncioTestCase):
 async def test_partial_completion_is_visible_without_reinsertion(self):
  import hashlib
  from types import SimpleNamespace
  texts=['done','bad','working'];sources=['amadeus-a','amadeus-b','amadeus-c']
  ids=['doc-'+hashlib.sha256((s+t).encode()).hexdigest() for s,t in zip(sources,texts)]
  rows={k:{'status':v} for k,v in zip(ids,['processed','failed','analyzing'])}
  class Values:
   async def get_by_id(self,k):return rows.get(k)
  rag=SimpleNamespace(doc_status=Values())
  value=await h.light_batch_progress(rag,texts,sources)
  self.assertEqual(value,dict(completed=1,failed=1,processing=1,pending=0,total=3))
  rows[ids[2]]['status']='processed'
  self.assertEqual((await h.light_batch_progress(rag,texts,sources))['completed'],2)
  self.assertEqual(rows[ids[1]]['status'],'failed')

class ExtractionTransport(unittest.IsolatedAsyncioTestCase):
 async def test_transient_retry_is_bounded_and_auth_does_not_retry(self):
  import sys
  from types import SimpleNamespace
  from unittest.mock import patch
  class TransportError(Exception):pass
  class TimeoutException(TransportError):pass
  class HttpError(Exception):
   def __init__(self,status):self.response=SimpleNamespace(status_code=status)
  events=[];errors=[]
  class Client:
   def __init__(self,**kw):pass
   async def __aenter__(self):return self
   async def __aexit__(self,*a):pass
   async def post(self,*a,**kw):
    events.append(1)
    if errors:raise errors.pop(0)
    return SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'choices':[{'finish_reason':'stop','message':{'content':'ok'}}]})
  async def sleep(_):pass
  tree=ast.parse((root/'scripts/retrieval_service.py').read_text(encoding='utf-8'))
  create=next(x for x in tree.body if isinstance(x,ast.AsyncFunctionDef) and x.name=='create_rag')
  fn=next(x for x in create.body if isinstance(x,ast.AsyncFunctionDef) and x.name=='complete')
  with tempfile.TemporaryDirectory() as tmp:
   env={'llm':{'model':'test','apiKey':'secret-key','baseUrl':'http://private'},'time':time,'json':json,'ROOT':Path(tmp),'JOB_LOCK':threading.RLock(),'asyncio':SimpleNamespace(sleep=sleep)}
   exec(compile(ast.Module(body=[fn],type_ignores=[]),'actual-complete','exec'),env)
   fake=SimpleNamespace(AsyncClient=Client,TimeoutException=TimeoutException,TransportError=TransportError)
   with patch.dict(sys.modules,{'httpx':fake}):
    errors.append(TransportError('secret payload'));self.assertEqual(await env['complete']('secret prompt'),'ok');self.assertEqual(len(events),2)
    events.clear();errors.extend([TransportError(),TransportError()])
    with self.assertRaises(RuntimeError):await env['complete']('secret prompt')
    self.assertEqual(len(events),2)
    events.clear();errors.append(HttpError(401))
    with self.assertRaises(RuntimeError):await env['complete']('secret prompt')
    self.assertEqual(len(events),1)
   log=(Path(tmp)/'extraction-errors.jsonl').read_text()
   self.assertNotIn('secret',log);self.assertIn('401',log)

if __name__=='__main__':unittest.main()
