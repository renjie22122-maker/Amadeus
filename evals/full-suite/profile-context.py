"""Bounded-memory context estimate; no inference and no truncation."""
import json,pathlib,sys
src=pathlib.Path(sys.argv[1]);dest=pathlib.Path(sys.argv[2]);decoder=json.JSONDecoder();buf='';eof=False;rows=[]
with src.open(encoding='utf8') as f:
 while True:
  buf=buf.lstrip(' \r\n\t,')
  if buf.startswith('['):buf=buf[1:];continue
  if buf.startswith(']'):break
  try:obj,end=decoder.raw_decode(buf)
  except json.JSONDecodeError:
   more=f.read(8*1024*1024)
   if not more:raise
   buf+=more;continue
  buf=buf[end:]
  text=json.dumps([{'date':date,'messages':[{'role':m['role'],'content':m['content']} for m in sess]} for date,sess in zip(obj['haystack_dates'],obj['haystack_sessions'])],ensure_ascii=False)
  ascii_n=sum(c.isascii() for c in text);units=int(ascii_n/3.5+len(text)-ascii_n)+12000
  rows.append({'id':obj['question_id'],'sessions':len(obj['haystack_sessions']),'characters':len(text),'estimatedInputUnits':units,'overWindowWithOutputReserve':units+32768>1048576})
dest.write_text(json.dumps({'method':'same ASCII/3.5 + non-ASCII estimate as runtime, plus 12k overhead; not exact provider tokenization','declaredWindow':1048576,'outputReserve':32768,'count':len(rows),'overBudget':sum(r['overWindowWithOutputReserve'] for r in rows),'rows':rows},indent=2),encoding='utf8')
print('M:',len(rows),'questions;',sum(r['overWindowWithOutputReserve'] for r in rows),'estimated over budget')
