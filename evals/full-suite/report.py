import json,pathlib,sys,collections
out=pathlib.Path(sys.argv[1]);coverage=json.loads((out/'coverage.json').read_text(encoding='utf8'));report={'tracks':{},'exclusions':coverage['exclusions']}
for track,info in coverage['tracks'].items():
 rows=[]
 if (out/track/'grades.json').exists():
  data=json.loads((out/track/'grades.json').read_text(encoding='utf8'));rows=data['grades'] if isinstance(data,dict) else data
 for arm in info.get('arms',['amadeus','smolagents']):
  results=[p for p in (out/track).glob('*-'+arm+'/result.json') if (p.parent/'process.json').exists()];errors=0;usage={'input':0,'output':0,'cached':0};unknown=0;passed=0;graded=0
  for path in results:
   r=json.loads(path.read_text(encoding='utf8'));errors+=bool(r.get('error'))
   us=[r.get('usage')] if 'requests' not in r else [x.get('result',{}).get('usage') or x.get('usage') for x in r['requests']]
   us += [x['usage'] for x in r.get('auxiliary',[]) if 'usage' in x]
   for u in us:
    if not u or not u.get('measured'):unknown+=1;continue
    for k in usage:usage[k]+=u.get(k,0)
   if track.startswith('longmem'):
    judge=path.parent/'judge.json'
    if judge.exists():
     j=json.loads(judge.read_text(encoding='utf8'))
     if j.get('passed') is not None:graded+=1;passed+=bool(j['passed'])
  if not track.startswith('longmem'):
   armrows=[r for r in rows if r['arm']==arm];graded=len(armrows);passed=sum(r.get('passed',r.get('grade',{}).get('valid',False)) for r in armrows)
  report['tracks'][track+'/'+arm]={'expected':info['cases'],'deliveredOrFailed':len(results),'runtimeErrors':errors,'graded':graded,'passed':passed,'unattempted':info['cases']-len(results),'usageMeasuredLowerBound':usage,'callsWithUnknownUsage':unknown}
(out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
lines=['# Full-track benchmark progress','', '| Track / agent | Expected | Attempted | Graded | Passed | Runtime errors |','|---|---:|---:|---:|---:|---:|']
for name,r in report['tracks'].items():lines.append('| '+name+' | '+' | '.join(str(r[k]) for k in ['expected','deliveredOrFailed','graded','passed','runtimeErrors'])+' |')
lines+=['','Scores are local controlled-adapter results, not official leaderboard submissions. Unattempted and ungraded work must not be called complete. LongMemEval here is full-context QA, not persisted memory.','', 'Excluded or blocked tracks:']+[ '- '+e['track']+': '+e['reason'] for e in report['exclusions']]
(out/'REPORT.md').write_text('\n'.join(lines),encoding='utf8');print(json.dumps(report,ensure_ascii=False))
