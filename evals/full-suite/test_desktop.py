import importlib.util, json, os, pathlib, tempfile, unittest
spec=importlib.util.spec_from_file_location('desktop',pathlib.Path(__file__).with_name('desktop.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class DesktopTests(unittest.TestCase):
 def test_live_process_and_lock(self):
  self.assertTrue(m.alive(os.getpid()))
  with tempfile.TemporaryDirectory() as tmp:
   p=pathlib.Path(tmp)/'lock'
   with m.ownership(p):
    with self.assertRaises(RuntimeError):
     with m.ownership(p): pass
   with m.ownership(p): pass
 def test_report_preserves_unknown_and_ungraded(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);(root/'text').mkdir();(root/'gaia').mkdir();queue=[]
   for i in range(3):
    d=root/str(i);d.mkdir();m.save(d/'started.json',{})
    queue.append(dict(track='longmem-s',arm='amadeus',id=str(i),directory=str(d)))
   m.save(root/'0/result.json',{'error':'NETWORK'});m.save(root/'0/process.json',{})
   m.save(root/'1/result.json',{'message':{'content':'answer'}});m.save(root/'1/process.json',{})
   m.save(root/'1/judge.json',{'passed':None,'error':'TIMEOUT'})
   m.save(root/'text/queue.json',queue)
   row=m.report({'root':str(root)})['rows'][0]
   self.assertEqual((row['completed'],row['errors'],row['unknown'],row['graded'],row['judgeErrors']),(2,1,1,0,1))
   self.assertTrue((root/'SUMMARY.md').exists())
 def test_profile_signature_excludes_credentials(self):
  result=m.profile_signature({'profiles':[{'id':'x','apiKey':'secret','model':'m'}]},'x')
  self.assertNotIn('secret',json.dumps(result))

if __name__=='__main__':unittest.main()
