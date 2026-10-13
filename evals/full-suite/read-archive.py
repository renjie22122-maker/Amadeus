"""Read structured office/archive attachments without executing their contents."""
import sys,json,zipfile,pathlib,xml.etree.ElementTree as ET
p=pathlib.Path(sys.argv[1]);member=sys.argv[2] if len(sys.argv)>2 else ''
with zipfile.ZipFile(p) as z:
 if p.suffix.lower()=='.pptx':
  names=sorted(n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml'))
  parts=[]
  for n in names:
   if z.getinfo(n).file_size>10_000_000:raise ValueError('slide too large')
   doc=ET.fromstring(z.read(n));parts.append(n+'\n'+' '.join(e.text or '' for e in doc.iter() if e.tag.endswith('}t')))
  print(json.dumps({'text':'\n\n'.join(parts)}))
 elif not member:print(json.dumps({'entries':[{'name':i.filename,'bytes':i.file_size} for i in z.infolist()]}))
 else:
  info=z.getinfo(member)
  if info.file_size>10_000_000:raise ValueError('member too large')
  data=z.read(info)
  print(json.dumps({'text':data.decode('utf8',errors='replace'),'member':member}))
