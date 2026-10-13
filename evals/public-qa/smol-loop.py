"""Native smolagents loop; model and read-only web calls go through a shared broker."""
import json,sys
from smolagents import Tool,ToolCallingAgent,Model,ChatMessage
def rpc(kind,payload):
 print(json.dumps({"kind":kind,**payload},ensure_ascii=False),flush=True)
 r=json.loads(sys.stdin.readline())
 if "error" in r: raise RuntimeError(r["error"])
 return r["result"]
class WebSearch(Tool):
 name="web_search";description="Search the public web. Verify important claims using fetch_url."
 inputs={"query":{"type":"string","description":"Search query"},"limit":{"type":"integer","description":"Maximum sources","nullable":True}}
 output_type="string"
 def forward(self,query:str,limit:int=6)->str:return rpc("tool",{"name":self.name,"args":{"query":query,"limit":limit}})
class Fetch(Tool):
 name="fetch_url";description="Fetch readable public web content. Private networks are blocked."
 inputs={"url":{"type":"string","description":"Public URL"}};output_type="string"
 def forward(self,url:str)->str:return rpc("tool",{"name":self.name,"args":{"url":url}})
class Attachment(Tool):
 name="benchmark_attachment";description="Read a task-provided attachment by exact name. Images supply pixels, documents supply paginated text. ZIP lists entries; member reads one entry. Audio/video transcription is unavailable."
 inputs={"name":{"type":"string","description":"Exact provided attachment name"},"offset":{"type":"integer","description":"Character offset","nullable":True},"member":{"type":"string","description":"ZIP entry name","nullable":True}};output_type="string"
 def forward(self,name:str,offset:int=0,member:str="")->str:return rpc("tool",{"name":self.name,"args":{"name":name,"offset":offset,"member":member}})
class Shell(Tool):
 name="benchmark_shell";description="Run a bash command inside the isolated benchmark container at /testbed. No host filesystem or network access. Use this for reading, editing and testing the repository."
 inputs={"command":{"type":"string","description":"Bash command (60 second limit)"}};output_type="string"
 def forward(self,command:str)->str:return rpc("tool",{"name":self.name,"args":{"command":command}})
class Broker(Model):
 def generate(self,messages,**kwargs):
  request=self._prepare_completion_kwargs(messages,**kwargs)
  r=rpc("model",{"request":request})
  return ChatMessage.from_dict(r)
job=json.loads(sys.stdin.readline())
def shared_tool(spec):
 inputs={k:{'type':v.get('type','string'),'description':v.get('description',k),**({'nullable':True} if k not in spec['parameters'].get('required',[]) else {})} for k,v in spec['parameters']['properties'].items()}
 def forward(self,**kwargs):return rpc('tool',{'name':self.name,'args':{k:v for k,v in kwargs.items() if v is not None}})
 cls=type('Shared_'+spec['name'],(Tool,),{'name':spec['name'],'description':spec['description'],'inputs':inputs,'output_type':'string','forward':forward,'skip_forward_signature_validation':True})
 return cls()
agent=ToolCallingAgent(tools=([shared_tool(s) for s in job['catalog']] if job.get('catalog') else [Shell()] if job.get("kind")=="swe" else [WebSearch(),Fetch(),Attachment()]),model=Broker(),max_steps=job.get("maxSteps",8),verbosity_level=-1,add_base_tools=False)
try:
 result=agent.run(job["prompt"])
 print(json.dumps({"kind":"final","answer":str(result)},ensure_ascii=False),flush=True)
except Exception as e:print(json.dumps({"kind":"failed","error":type(e).__name__}),flush=True)

