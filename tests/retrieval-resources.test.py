import importlib.util, unittest, ast
from pathlib import Path
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('resources', root/'scripts/rag_resources.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
class Resources(unittest.TestCase):
 def setUp(self):
  self.now=0;self.p=h.ResourcePolicy(clock=lambda:self.now)
 def observe(self,free=10000,util=10,**extra):
  self.p.observe(dict(available=True,freeMiB=free,utilPercent=util,**extra))
 def ready(self):
  self.observe();self.now=31;self.observe()
 def test_pressure_hysteresis_and_resume(self):
  self.ready();self.assertTrue(self.p.state()['admitGraph'])
  self.observe(free=500);self.assertFalse(self.p.state()['admitGraph']);self.assertTrue(self.p.should_release())
  self.now=40;self.observe();self.now=69;self.observe();self.assertFalse(self.p.state()['admitGraph'])
  self.now=71;self.observe();self.assertTrue(self.p.state()['admitGraph'])
 def test_busy_compute_even_with_free_memory(self):
  self.ready();self.observe(util=99);self.assertEqual(self.p.state()['reason'],'gpu_busy')
 def test_foreground_admission_and_idle_release(self):
  self.ready();self.p.used();self.p.foreground=1
  self.assertFalse(self.p.state()['admitGraph']);self.p.foreground=0
  self.assertTrue(self.p.state()['admitGraph']);self.assertFalse(self.p.should_release())
  self.now=152;self.observe();self.assertTrue(self.p.should_release())
 def test_stale_or_failed_telemetry_never_claims_gpu_ready(self):
  self.ready();self.now=50;self.assertFalse(self.p.state()['gpuAllowed'])
  self.p.observe(dict(available=False));self.assertFalse(self.p.state()['admitGraph'])
 def test_cpu_only_can_build_but_host_pressure_yields(self):
  self.p.observe(dict(available=False,reason='cpu_only'))
  self.assertTrue(self.p.state()['admitGraph']);self.assertFalse(self.p.state()['gpuAllowed'])
  self.p.observe(dict(available=False,reason='cpu_only',cpuPercent=95))
  self.assertFalse(self.p.state()['admitGraph'])
 def test_release_cannot_move_active_inference(self):
  tree=ast.parse((root/'scripts/retrieval_service.py').read_text(encoding='utf-8'))
  function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='release_models')
  import threading
  lock=threading.Lock();moves=[]
  ns=dict(LOCK=lock,MODELS={'embedding':object()},place_model=lambda *x:moves.append(x))
  exec(compile(ast.Module(body=[function],type_ignores=[]),'release','exec'),ns)
  lock.acquire();ns['release_models']();self.assertEqual(moves,[]);lock.release()
  ns['release_models']();self.assertEqual(moves[0][2],'cpu')
 def test_wait_is_not_failure_or_document_replay(self):
  from types import SimpleNamespace
  import threading
  tree=ast.parse((root/'scripts/retrieval_service.py').read_text(encoding='utf-8'))
  fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run_job')
  state={'admitGraph':False,'reason':'gpu_busy'};jobs={'original':{'status':'queued','completed':3}}
  attempts=[];waits=[]
  def sleep(seconds):
   waits.append(seconds);self.assertEqual(attempts,[]);self.assertEqual(jobs['original']['completed'],3)
   state['admitGraph']=True
  def attempt(key,data,resume):
   attempts.append((key,data,resume));jobs[key]['status']='completed'
  env=dict(JOB_LOCK=threading.RLock(),ACTIVE_JOBS=set(),JOBS=jobs,
   GRAPH_EMBEDDINGS=SimpleNamespace(idle=lambda:True),RESOURCES=SimpleNamespace(state=lambda:dict(state)),
   release_models=lambda:None,save_jobs=lambda:None,time=SimpleNamespace(time=lambda:1,sleep=sleep),run_job_attempt=attempt)
  exec(compile(ast.Module(body=[fn],type_ignores=[]),'job','exec'),env)
  env['run_job']('original',{'texts':['unchanged']},True)
  self.assertEqual(waits,[5]);self.assertEqual(attempts,[('original',{'texts':['unchanged']},True)])
  self.assertNotIn('automaticRetries',jobs['original']);self.assertNotIn('resourceWait',jobs['original'])
if __name__=='__main__':unittest.main()
