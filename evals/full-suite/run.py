"""Durable paired batch runner. No ambiguous started attempt is automatically replayed."""
import argparse,concurrent.futures,datetime,json,os,pathlib,subprocess,threading,time,hashlib,sys
p=argparse.ArgumentParser();p.add_argument('output');p.add_argument('runtime');p.add_argument('python');p.add_argument('settings');p.add_argument('--analysis-image');p.add_argument('--concurrency',type=int,default=4);p.add_argument('--limit',type=int);p.add_argument('--prepare-python',default=sys.executable);p.add_argument('--download',required=True);a=p.parse_args()
out=pathlib.Path(a.output).resolve();runtime=pathlib.Path(a.runtime).resolve();queue=json.loads((out/'queue.json').read_text(encoding='utf8'));queue=queue[:a.limit] if a.limit else queue
clean=any(json.loads(pathlib.Path(i['job']).read_text(encoding='utf8')).get('protocol') in ['shared-evidence-v2','native-evidence-v1'] for i in queue if i['track']=='gaia')
if clean:
 if not a.analysis_image:raise ValueError('Shared evidence protocol requires --analysis-image with an immutable sha256 image ID')
 if not a.analysis_image.startswith('sha256:'):raise ValueError('Freeze the Docker image ID, not a mutable tag')
 native=any(json.loads(pathlib.Path(i['job']).read_text(encoding='utf8')).get('protocol')=='native-evidence-v1' for i in queue if i['track']=='gaia')
 probe_code='import shutil; assert shutil.which("ffmpeg"); print("ready")'
 if native:probe_code+='; import smolagents, ddgs, markdownify, openpyxl, pypdf, PIL'
 probe=subprocess.run(['docker','run','--pull=never','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user','1000:1000',a.analysis_image,'python3','-c',probe_code],capture_output=True,text=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
 if probe.returncode:raise RuntimeError('Analysis image preflight failed; no paid model calls started: '+probe.stderr[-500:])
lock=out/'runner.lock'
with lock.open('x') as f:json.dump({'pid':os.getpid(),'at':time.time()},f)
selected_tracks={i['track'] for i in queue}
mutex=threading.Lock();active={};finished=0;errors=0;skipped=0;started=time.time();flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
settings=json.loads(pathlib.Path(a.settings).read_text(encoding='utf8'));profile_id=settings['defaultProfileId'];profile=next(p for p in settings['profiles'] if p['id']==profile_id)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(path,value):
 tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
 for attempt in range(20):
  try:
   os.replace(tmp,path);return
  except PermissionError:
   if attempt==19:raise
   time.sleep(min(0.05*(attempt+1),0.25))
def progress(phase='solving'):
 try:save(out/'progress.json',{'phase':phase,'updatedAt':now(),'totalAttempts':len(queue),'finishedThisRun':finished,'errorAttemptsThisRun':errors,'existingOrUnknownSkipped':skipped,'active':list(active.values()),'elapsedSeconds':round(time.time()-started),'stopRequested':(out/'STOP').exists()})
 except OSError as e:print('Progress snapshot unavailable: '+type(e).__name__,file=sys.stderr,flush=True)
def run_one(item):
 global finished,errors,skipped
 directory=pathlib.Path(item['directory']);receipt=directory/'started.json';jobpath=pathlib.Path(item['job'])
 with mutex:
  if (out/'STOP').exists():return
  if receipt.exists():skipped+=1;progress();return
  job=json.loads(jobpath.read_text(encoding='utf8'));job.update({'expectedModel':profile['model'],'expectedEndpoint':profile['baseUrl'],'settings':str(pathlib.Path(a.settings).resolve()),'profileId':profile_id,'python':a.python,'timeoutMs':180000,'analysisImage':a.analysis_image})
  save(jobpath,job);save(receipt,{'at':now(),'runtime':str(runtime),'jobSha256':hashlib.sha256(jobpath.read_bytes()).hexdigest()})
  active[str(jobpath)]={'track':item['track'],'id':item['id'],'arm':item['arm'],'startedAt':now()};progress()
 timedout=False;code=None
 with (directory/'worker.stdout.log').open('w',encoding='utf8') as stdout,(directory/'worker.stderr.log').open('w',encoding='utf8') as stderr:
  child=subprocess.Popen(['node','--import','tsx',item['worker'],str(jobpath)],cwd=runtime,stdout=stdout,stderr=stderr,creationflags=flags)
  try:code=child.wait(timeout=660 if item['track']=='gaia' else 240)
  except subprocess.TimeoutExpired:
   timedout=True
   if os.name=='nt':subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=flags)
   else:child.kill()
   child.wait()
 result=directory/'result.json'
 if not result.exists():save(result,{'error':'EVAL_TIMEOUT' if timedout else 'EVAL_WORKER_EXIT','elapsedMs':0,'answer':''})
 data=json.loads(result.read_text(encoding='utf8'));save(directory/'process.json',{'exitCode':code,'timedOut':timedout,'completedAt':now()})
 with mutex:
  active.pop(str(jobpath),None);finished+=1;errors+=bool(data.get('error'));progress()
 print(item['track'],item['id'],item['arm'],data.get('error','delivered'),flush=True)
def command(args):
 with (out/'grading.log').open('a',encoding='utf8') as f:
  r=subprocess.run(args,cwd=runtime,stdout=f,stderr=f,creationflags=flags)
  if r.returncode:raise RuntimeError('Grading command failed: '+args[1])
def judge_one(item):
 folder,index=item
 command(['node','--import','tsx','evals/public-qa/judge.ts',str(folder),str(index),str(pathlib.Path(a.settings).resolve()),profile_id])
try:
 manifest={'startedAt':now(),'runtime':str(runtime),'queueSha256':hashlib.sha256((out/'queue.json').read_bytes()).hexdigest(),'concurrency':a.concurrency,'model':profile['model'],'profileId':profile_id,'endpoint':profile['baseUrl'],'reasoning':profile.get('reasoning','auto'),'outputTokens':32768,'maxGAIAModelCalls':16,'prices':profile.get('prices'),'baseline':'smolagents 1.26.0; see per-track arms/protocol for native or controlled tools','grading':'BFCL upstream AST; GAIA frozen official scorer; LongMemEval upstream rubric with disclosed DeepSeek judge (not blind, not official GPT4o score)','analysisImage':a.analysis_image,'scope':'See coverage.json; counts are task attempts, not passes','dataPolicy':'Only benchmark questions/history and provided attachments; no user conversation or project knowledge'}
 if not (out/'manifest.json').exists():save(out/'manifest.json',manifest)
 with concurrent.futures.ThreadPoolExecutor(max_workers=a.concurrency) as pool:list(pool.map(run_one,queue))
 if (out/'STOP').exists():
  progress('paused');sys.exit(0)
 progress('grading')
 if 'bfcl' in selected_tracks:command([a.python,'-X','utf8','evals/bfcl/dataset.py','grade',str(pathlib.Path(a.download)/'sources/bfcl/berkeley-function-call-leaderboard'),str(out/'bfcl')])
 if 'gaia' in selected_tracks:command([a.prepare_python,'-X','utf8','evals/public-qa/grade-gaia.py',str(out/'gaia')])
 judges=[]
 for track in ['longmem-s','longmem-oracle']:
  if track not in selected_tracks:continue
  folder=out/track
  command([a.python,'-X','utf8','evals/public-qa/prepare-judge.py',a.download,str(folder)])
  prompts=json.loads((folder/'judge-prompts.json').read_text(encoding='utf8'))
  judges.extend((folder,i) for i in range(len(prompts)))
 with concurrent.futures.ThreadPoolExecutor(max_workers=a.concurrency) as pool:list(pool.map(judge_one,judges))
 command([a.python,'-X','utf8','evals/full-suite/report.py',str(out)])
 progress('paused' if (out/'STOP').exists() else 'finished')
except Exception as e:
 save(out/'runner-error.json',{'type':type(e).__name__,'message':str(e),'at':now()});progress('failed');raise
finally:lock.unlink(missing_ok=True)
