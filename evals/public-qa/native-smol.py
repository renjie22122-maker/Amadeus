"""Native smolagents tools/loops in an offline container; host RPC only enforces egress/model boundaries."""
import json,sys,pathlib,base64,io
# Protocol streams are independent of model-code print capture.
protocol_out=sys.stdout
protocol_in=sys.stdin
from smolagents import Tool,ToolCallingAgent,CodeAgent,Model,ChatMessage
from smolagents.default_tools import PythonInterpreterTool,DuckDuckGoSearchTool,VisitWebpageTool

def rpc(kind,**payload):
 print(json.dumps({'kind':kind,**payload}),file=protocol_out,flush=True)
 r=json.loads(protocol_in.readline())
 if 'error' in r:raise RuntimeError(r['error'])
 return r['result']
class Broker(Model):
 def generate(self,messages,**kwargs):
  return ChatMessage.from_dict(rpc('model',request=self._prepare_completion_kwargs(messages,**kwargs)))
class SearchBackend:
 def text(self,query,max_results=10,**kw):return rpc('native_search',query=query,limit=max_results)
search=DuckDuckGoSearchTool(max_results=6);search.ddgs=SearchBackend()
# Retain VisitWebpageTool's native HTML-to-Markdown processing. The shared transport gates each redirect.
import requests
original_get=requests.get
class Response:
 def __init__(self,r):self.text=r['text'];self.status_code=r['status']
 def raise_for_status(self):
  if self.status_code>=400:raise requests.HTTPError(str(self.status_code))
def safe_get(url,**kwargs):return Response(rpc('native_fetch',url=url))
requests.get=safe_get

def scoped(name):
 p=(pathlib.Path('/workspace')/name).resolve()
 if not p.is_relative_to('/workspace') or not p.is_file():raise ValueError('File outside task workspace')
 return p
class ReadFile(Tool):
 name='read_task_file';description='Read task files with native Python libraries. XLSX returns coordinates, values and fills. PDF returns text. Images use inspect_image. Archives list members. offset pages characters.'
 inputs={'name':{'type':'string','description':'Relative file name'},'offset':{'type':'integer','description':'Character offset','nullable':True}};output_type='string'
 def forward(self,name:str,offset:int=0)->str:
  p=scoped(name);ext=p.suffix.lower();offset=offset or 0
  if ext=='.xlsx':
   import openpyxl
   w=openpyxl.load_workbook(p,read_only=False,data_only=False);rows=[]
   for s in w:
    for row in s:
     for c in row:
      if c.value is not None or c.has_style:rows.append({'sheet':s.title,'coordinate':c.coordinate,'value':c.value,'fill':str(c.fill.fgColor),'number_format':c.number_format})
   text=json.dumps(rows,default=str)
  elif ext=='.pdf':
   from pypdf import PdfReader
   text='\n'.join(p.extract_text() or '' for p in PdfReader(p).pages)
  elif ext=='.zip':
   import zipfile
   with zipfile.ZipFile(p) as z:text=json.dumps(z.namelist())
  else:text=p.read_text(encoding='utf8')
  return json.dumps({'text':text[offset:offset+24000],'nextOffset':offset+24000 if offset+24000<len(text) else None,'totalCharacters':len(text)})
class Image(Tool):
 name='inspect_image';description='Inspect pixels from a task-workspace image. Optionally crop original pixels using left,top,width,height. Images are attached to the next model input.'
 inputs={'name':{'type':'string','description':'Relative filename'},**{k:{'type':'integer','description':k,'nullable':True} for k in ['left','top','width','height']}};output_type='string'
 def forward(self,name:str,left:int=0,top:int=0,width:int=None,height:int=None)->str:
  from PIL import Image as PILImage
  im=PILImage.open(scoped(name));im.seek(0)
  if width is not None:
   left=left or 0;top=top or 0;height=height or width
   if min(left,top)<0 or min(width,height)<=0 or left+width>im.width or top+height>im.height:raise ValueError('Invalid crop')
   im=im.crop((left,top,left+width,top+height))
  im.thumbnail((1600,1600));buf=io.BytesIO();im.convert('RGB').save(buf,format='PNG')
  return str(rpc('native_image',name=name,data=base64.b64encode(buf.getvalue()).decode()))
job=json.loads(sys.stdin.readline())
imports=['math','statistics','decimal','json','csv','pathlib','zipfile','openpyxl','pypdf','PIL','subprocess']
tools=[search,VisitWebpageTool(),ReadFile(),Image()]
kwargs=dict(tools=tools,model=Broker(),max_steps=job['maxSteps'],verbosity_level=-1,add_base_tools=False)
if job['arm']=='smolagents-code':agent=CodeAgent(**kwargs,additional_authorized_imports=imports)
else:
 kwargs['tools'].append(PythonInterpreterTool(authorized_imports=imports,timeout_seconds=30))
 agent=ToolCallingAgent(**kwargs)
try:
 result=agent.run(job['prompt'])
 print(json.dumps({'kind':'final','answer':str(result)}),flush=True)
except Exception as e:print(json.dumps({'kind':'failed','error':type(e).__name__}),flush=True)
