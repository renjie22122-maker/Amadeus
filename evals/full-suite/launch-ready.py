"""Opt-in preparation gate for already prepared, frozen native/control runs. No host fallback."""
import argparse,datetime,json,os,pathlib,subprocess,time
p=argparse.ArgumentParser()
for name in ['runtime','native','control','python','data-python','settings','download']:p.add_argument('--'+name,required=True)
p.add_argument('--base-image',default='amadeus-analysis:local');p.add_argument('--image',default='amadeus-evaluation:local');p.add_argument('--wait-hours',type=float,default=6)
a=p.parse_args();root=pathlib.Path(a.native);runtime=pathlib.Path(a.runtime);flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
state=root/'launch-status.json'
def status(phase,**extra):
 state.write_text(json.dumps({'phase':phase,'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),**extra},indent=2),encoding='utf8')
def run(args,**kw):return subprocess.run(args,cwd=runtime,creationflags=flags,**kw)
def image_id(tag):
 r=run(['docker','image','inspect','--format','{{.Id}}',tag],capture_output=True,text=True,timeout=20)
 return r.stdout.strip() if r.returncode==0 else None
children=[]
try:
 deadline=time.monotonic()+a.wait_hours*3600
 while not image_id(a.base_image):
  if (root/'STOP-SETUP').exists():status('paused');raise SystemExit(0)
  if time.monotonic()>deadline:raise RuntimeError('Analysis image did not become ready within preparation deadline')
  status('waiting_for_analysis_image',baseImage=a.base_image);time.sleep(30)
 status('building_native_evaluation_image')
 with (root/'evaluation-image.log').open('w',encoding='utf8') as log:
  build=run(['docker','build','--build-arg','ANALYSIS_IMAGE='+a.base_image,'-t',a.image,'-f','docker/analysis/Dockerfile.eval','docker/analysis'],stdout=log,stderr=log,timeout=21600)
 if build.returncode:raise RuntimeError('Evaluation image build failed; no paid evaluation started')
 digest=image_id(a.image)
 if not digest or not digest.startswith('sha256:'):raise RuntimeError('Cannot freeze evaluation image')
 status('synthetic_preflight',image=digest)
 env={**os.environ,'AMADEUS_EVAL_PYTHON':a.python,'AMADEUS_TEST_ANALYSIS_IMAGE':digest,'AMADEUS_TEST_NATIVE_IMAGE':digest}
 with (root/'native-smoke.log').open('w',encoding='utf8') as log:
  smoke=run(['node','--import','tsx','--test','tests/shared-broker.test.ts'],env=env,stdout=log,stderr=log,timeout=300)
 if smoke.returncode:raise RuntimeError('Native/control synthetic preflight failed; no paid evaluation started')
 versions=run(['docker','run','--rm','--network=none',digest,'python3','-m','pip','freeze'],capture_output=True,text=True,timeout=30)
 if versions.returncode:raise RuntimeError('Cannot record package versions')
 (root/'evaluation-packages.txt').write_text(versions.stdout,encoding='utf8')
 for folder in [a.native,a.control]:
  target=pathlib.Path(folder)
  if (target/'STOP').exists():continue
  args=[a.python,str(runtime/'evals/full-suite/run.py'),folder,str(runtime),a.python,a.settings,'--download',a.download,'--prepare-python',a.data_python,'--analysis-image',digest,'--concurrency','2']
  with (target/'runner.log').open('a',encoding='utf8') as log:
   children.append(subprocess.Popen(args,cwd=runtime,stdout=log,stderr=log,creationflags=flags))
 status('running',image=digest,pids=[p.pid for p in children])
 codes=[p.wait() for p in children]
 status('finished' if all(c==0 for c in codes) else 'failed',exitCodes=codes,image=digest)
except Exception as e:
 status('failed',error=type(e).__name__+': '+str(e));raise
