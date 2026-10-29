import unittest, importlib.util, tempfile, http.cookiejar, socket
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('worker',Path(__file__).resolve().parents[1]/'server/services/video-reader-worker.py')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class VideoWorkerTests(unittest.TestCase):
    def test_public_network(self):
        for ip in ['127.0.0.1','10.0.0.1','169.254.169.254','::1','fc00::1','224.0.0.1','198.18.0.1']:
            self.assertFalse(w.public_ip(ip))
        self.assertTrue(w.public_ip('1.1.1.1'))
        original_dns,original_connect=socket.getaddrinfo,socket.socket.connect
        try:
            with patch.object(socket,'getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',443))]):
                w.protect_network()
                with self.assertRaisesRegex(ValueError,'NETWORK_DENIED'): socket.getaddrinfo('public.example',443)
        finally: socket.getaddrinfo,socket.socket.connect=original_dns,original_connect
    def test_cookie_domain_and_no_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'cookies.txt'
            path.write_text('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSESSION\tyoutube-value\n.example.com\tTRUE\t/\tTRUE\t2147483647\tSECRET\tprivate-value\n',encoding='utf-8')
            before=path.read_bytes(); jar=w.cookie_jar(str(path),'youtube')
            self.assertEqual([c.name for c in jar],['SESSION']); self.assertEqual(path.read_bytes(),before)
            self.assertEqual(len(w.cookie_jar(str(path),'bilibili')),0)
    def test_bili_comments_part_and_reply_scope(self):
        calls=[]
        def api(path,q,jar):
            calls.append((path,q))
            if 'web-interface/view' in path: return {'aid':42,'pages':[{'cid':1},{'cid':2}]}
            return {'page':{'count':41},'replies':[{'rpid_str':'9','parent':8,'mid':7,'member':{'uname':'reader'},'content':{'message':'comment'},'rcount':3}]}
        with patch.object(w,'bili_api',side_effect=api):
            result=w.bili_social({'url':'https://www.bilibili.com/video/BVabc?p=2','action':'comments','page':2,'root':'8'},http.cookiejar.MozillaCookieJar())
        self.assertEqual(result['nextPage'],3);self.assertEqual(result['comments'][0]['authorId'],'7')
        self.assertEqual(calls[-1][1]['oid'],42); self.assertEqual(calls[-1][1]['root'],'8')
        self.assertEqual(calls[-1][0],'/x/v2/reply/reply')
    def test_dynamic_preserves_original_author_and_media(self):
        item={'id_str':'12','modules':{'module_author':{'mid':2,'name':'A'},'module_dynamic':{'desc':{'text':'new'},'major':{'draw':{'items':[{'src':'https://i.example/p.jpg'}]}}}},'orig':{'id_str':'11','modules':{'module_author':{'mid':3,'name':'B'},'module_dynamic':{'desc':{'text':'original'}}}}}
        result=w.clean_dynamic(item)
        self.assertEqual(result['author']['id'],'2');self.assertEqual(result['original']['author']['id'],'3');self.assertEqual(len(result['images']),1)
    def test_bili_probe_uses_api_part_and_caption_provenance(self):
        def api(path,q,jar):
            if path.endswith('/view'):return {'aid':42,'bvid':'BVabc','title':'parts','pages':[{'cid':1,'duration':5},{'cid':2,'duration':8}]}
            self.assertEqual(q['cid'],2)
            return {'subtitle':{'subtitles':[{'lan':'ai-zh','ai_type':1},{'lan':'en','ai_type':0}]}}
        with patch.object(w,'bili_api',side_effect=api):
            result=w.bili_video({'url':'https://www.bilibili.com/video/BVabc?p=2','action':'probe'},http.cookiejar.MozillaCookieJar())
        self.assertEqual(result['duration'],8)
        self.assertEqual([t['kind'] for t in result['tracks']],['automatic','author'])
        self.assertFalse(result['credentialsProvided'])
    def test_url_denials(self):
        for url in ['https://localhost/a','file:///secret','https://youtube.com:999/watch?v=x','https://user:secret@youtube.com/watch?v=x']:
            with self.assertRaises(ValueError): w.platform_url(url)

class RangeTests(unittest.TestCase):
    def test_seek_reads_ranges_and_reuses_blocks(self):
        import io
        spec=importlib.util.spec_from_file_location('r',Path('server/services/video-range.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
        payload=b'a'*300000+b'b'*300000;calls=[]
        class Response(io.BytesIO):pass
        def open_request(request):
            start,end=map(int,request.headers['Range'].removeprefix('bytes=').split('-'));end=min(end,len(payload)-1);calls.append((start,end));response=Response(payload[start:end+1]);response.status=206;response.headers={'Content-Range':f'bytes {start}-{end}/{len(payload)}'};return response
        source=r.RangeReader(open_request,'https://example.com/video');source.seek(300001);self.assertEqual(source.read(5),b'bbbbb');self.assertEqual(len(calls),2);source.seek(0);self.assertEqual(source.read(5),b'aaaaa');self.assertEqual(len(calls),2)
        source.seek(-2,2);self.assertEqual(source.read(9),b'bb');self.assertLessEqual(source.transferred,len(payload))
    def test_no_full_download_fallback(self):
        import io
        spec=importlib.util.spec_from_file_location('r',Path('server/services/video-range.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
        class Response(io.BytesIO):
            status=200;headers={}
            def read(self,*args):raise AssertionError('must not read full response')
        with self.assertRaisesRegex(ValueError,'RANGE_UNSUPPORTED'):r.RangeReader(lambda req:Response(), 'https://example.com/video')
class DecodeRangeTests(unittest.TestCase):
    def test_actual_partial_video_and_audio_decode(self):
        import importlib.util, shutil, subprocess, io, wave
        if not importlib.util.find_spec('av') or not shutil.which('ffmpeg'):
            self.skipTest('PyAV and FFmpeg required for opt-in decoder integration')
        spec=importlib.util.spec_from_file_location('r',Path('server/services/video-range.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'test.mp4'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=12','-f','lavfi','-i','sine=frequency=440:duration=12','-c:v','libx264','-threads','1','-c:a','aac','-movflags','+faststart',str(path)],check=True)
            payload=path.read_bytes()
            class Response(io.BytesIO):pass
            class Transport:
                def urlopen(self,request):
                    lo,hi=map(int,request.headers['Range'][6:].split('-'));hi=min(hi,len(payload)-1)
                    response=Response(payload[lo:hi+1]);response.status=206;response.headers={'Content-Range':f'bytes {lo}-{hi}/{len(payload)}'};return response
            info={'formats':[{'url':'https://example.com/fixture','protocol':'https','vcodec':'h264','acodec':'aac','width':320,'height':180}]}
            result=r.remote_frames({'folder':folder,'from':2,'seconds':4,'cells':2},info,Transport())
            self.assertEqual(len(result['frames']),2)
            self.assertAlmostEqual(result['frames'][0]['actualTime'],3,delta=.11)
            self.assertTrue((Path(folder)/'range-0.png').exists())
            audio=r.remote_audio({'folder':folder,'from':2,'seconds':4},info,Transport())
            self.assertAlmostEqual(audio['audioSeconds'],4,delta=.02)
            with wave.open(str(Path(folder)/'range-audio.wav')) as wav:self.assertEqual(wav.getframerate(),16000)
if __name__=='__main__': unittest.main()
