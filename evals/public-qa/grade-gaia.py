import pathlib,json,sys,importlib.util,re
p=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location("gaia_official_scorer",p/"official-scorer.py")
scorer=importlib.util.module_from_spec(spec);spec.loader.exec_module(scorer)
rows=[]
for ref in json.loads((p/"references.json").read_text(encoding="utf-8")):
 for arm in ["amadeus","smolagents","smolagents-code"]:
  path=p/(ref["id"]+"-"+arm)/"result.json"
  if not path.exists():continue
  r=json.loads(path.read_text(encoding="utf-8"));raw=r.get("answer","")
  matches=re.findall(r"FINAL ANSWER:\s*(.+)",raw,re.I)
  answer=matches[-1].strip() if matches and r.get('protocol','legacy')=='legacy' else raw.strip()
  passed=scorer.question_scorer(answer,str(ref["answer"])) if answer and not r.get("error") else False
  rows.append({"id":ref["id"],"arm":arm,"answer":answer,"reference":ref["answer"],"passed":passed,"runtimeError":r.get("error"),"elapsedMs":r["elapsedMs"],"modelCalls":len(r.get("requests",[])),"toolResults":len(r.get("tools",[]))})
(p/"grades.json").write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding="utf-8")
for arm in ["amadeus","smolagents","smolagents-code"]:
 rs=[r for r in rows if r["arm"]==arm];print(arm,sum(r["passed"] for r in rs),"/",len(rs))

