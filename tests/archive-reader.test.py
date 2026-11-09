import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
import tarfile
import io
from pathlib import Path

@unittest.skipUnless(importlib.util.find_spec('libarchive'), 'optional libarchive-c decoder is not installed')
class ArchiveReaderTests(unittest.TestCase):
    def test_formats_and_path_safety(self):
        import libarchive
        with tempfile.TemporaryDirectory() as tmp:
            for fmt, suffix in [('zip','zip'),('7zip','7z'),('pax_restricted','tar')]:
                path=Path(tmp)/('sample.'+suffix)
                with libarchive.file_writer(str(path),fmt) as archive:
                    archive.add_file_from_memory('hello.txt',5,b'hello')
                for member in [None,'hello.txt']:
                    args=[sys.executable,'server/services/archive-reader.py',str(path)]+([member] if member else [])
                    result=json.loads(subprocess.check_output(args))
                    self.assertNotIn('error',result)
                    if member: self.assertEqual(result['bytesBase64'],'aGVsbG8=')
                    else: self.assertEqual(result['entries'][0]['name'],'hello.txt')
            for suffix, mode in [('tar.gz','w:gz'), ('tar.xz','w:xz'), ('tar.bz2','w:bz2')]:
                path=Path(tmp)/('sample.'+suffix)
                with tarfile.open(path, mode) as archive:
                    info=tarfile.TarInfo('hello.txt'); info.size=5
                    archive.addfile(info,io.BytesIO(b'hello'))
                result=json.loads(subprocess.check_output([sys.executable,'server/services/archive-reader.py',str(path),'hello.txt']))
                self.assertEqual(result.get('bytesBase64'),'aGVsbG8=',result)
            path=Path(tmp)/'unsafe.zip'
            with zipfile.ZipFile(path,'w') as archive: archive.writestr('../escape.txt','bad')
            result=json.loads(subprocess.check_output([sys.executable,'server/services/archive-reader.py',str(path),'../escape.txt']))
            self.assertIn('error',result)
            self.assertFalse((Path(tmp).parent/'escape.txt').exists())

if __name__=='__main__': unittest.main()
