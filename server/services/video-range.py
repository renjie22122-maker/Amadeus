"""Bounded seekable HTTP reader: never falls back to fetching an entire remote file."""
import io,re,urllib.request
class RangeReader(io.RawIOBase):
    def __init__(self,open_request,url,headers=None,max_bytes=64*1024*1024):
        self.open_request=open_request;self.url=url;self.headers=dict(headers or {});self.position=0;self.size=None;self.transferred=0;self.requests=0;self.limit=max_bytes;self.blocks={};self.block_size=256*1024
        self._block(0)
    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.position
    def seek(self,offset,whence=0):
        position=offset if whence==0 else self.position+offset if whence==1 else self.size+offset if whence==2 else -1
        if position<0: raise ValueError('RANGE_SEEK: invalid seek')
        self.position=position;return position
    def _block(self,start):
        if start in self.blocks:return self.blocks[start]
        end=start+self.block_size-1
        if self.size is not None:end=min(end,self.size-1)
        if self.transferred+end-start+1>self.limit:raise ValueError('RANGE_BUDGET: partial-read transfer limit exceeded')
        request=urllib.request.Request(self.url,headers={**self.headers,'Range':f'bytes={start}-{end}','Accept-Encoding':'identity'})
        with self.open_request(request) as response:
            if response.status!=206:raise ValueError('RANGE_UNSUPPORTED: server ignored range; no full download performed')
            match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',response.headers.get('Content-Range',''))
            if not match or int(match[1])!=start or int(match[2])>end:raise ValueError('RANGE_INVALID: unexpected Content-Range')
            size=int(match[3])
            if self.size is not None and size!=self.size:raise ValueError('RANGE_CHANGED: remote file changed')
            raw=response.read(end-start+2)
            if len(raw)!=int(match[2])-start+1:raise ValueError('RANGE_INVALID: response length mismatch')
        self.size=size;self.transferred+=len(raw);self.requests+=1
        if len(self.blocks)>=128:self.blocks.pop(next(iter(self.blocks)))
        self.blocks[start]=raw;return raw
    def read(self,n=-1):
        if self.position>=self.size:return b''
        n=min(self.size-self.position,n if n>=0 else self.limit)
        result=[]
        while n:
            start=self.position//self.block_size*self.block_size;block=self._block(start);offset=self.position-start;part=block[offset:offset+n]
            if not part:break
            result.append(part);self.position+=len(part);n-=len(part)
        return b''.join(result)
    def readinto(self,buffer):
        value=self.read(len(buffer));buffer[:len(value)]=value;return len(value)

def remote_frames(a,info,ydl):
    import av
    from pathlib import Path
    folder=Path(a['folder']);cells=int(a.get('cells',4));start=float(a.get('from',0));seconds=float(a.get('seconds',30));height=1080 if cells==1 else 360
    if not 1<=cells<=16 or not 0<seconds<=600 or start<0:raise ValueError('VIDEO_WINDOW: invalid window')
    candidates=[f for f in info.get('formats',[]) if f.get('url') and f.get('vcodec') not in (None,'none') and f.get('protocol') in ('http','https')]
    if not candidates:raise ValueError('RANGE_FORMAT: no direct HTTP video stream')
    short=lambda f:min(f.get('height') or height,f.get('width') or height)
    below=[f for f in candidates if short(f)<=height]
    chosen=max(below,key=lambda f:(short(f),f.get('tbr') or 0)) if below else min(candidates,key=short)
    # All HTTP passes through the same checked resolver, including redirects. Never give FFmpeg a URL.
    source=RangeReader(ydl.urlopen,chosen['url'],chosen.get('http_headers'),max_bytes=64*1024*1024)
    frames=[]
    with av.open(source,mode='r',options={'protocol_whitelist':'file,pipe','format_whitelist':'mov,matroska,webm,avi,flv,ogg,mpegts'}) as container:
        stream=container.streams.video[0];stream.codec_context.thread_count=1
        for index in range(cells):
            requested=start+(index+0.5)*seconds/cells
            container.seek(int(requested/stream.time_base),stream=stream,backward=True)
            found=None
            for frame in container.decode(stream):
                if frame.time is not None and frame.time>=requested:
                    found=frame;break
            if found is None:raise ValueError('VIDEO_FRAME: requested timestamp not decoded')
            image=found.to_image();image.thumbnail((1280,720) if cells==1 else (320,180));image.save(folder/f'range-{index}.png')
            frames.append({'cell':index+1,'requestedTime':requested,'actualTime':found.time})
    return {'frames':frames,'transferredBytes':source.transferred,'rangeRequests':source.requests,'sourceBytes':source.size,'mode':'http-range','width':chosen.get('width'),'height':chosen.get('height')}

def remote_audio(a,info,ydl):
    import av,wave,math
    from pathlib import Path
    start=float(a.get('from',0));seconds=float(a.get('seconds',30));end=start+seconds
    if start<0 or not 0<seconds<=600:raise ValueError('VIDEO_WINDOW: invalid audio window')
    candidates=[f for f in info.get('formats',[]) if f.get('url') and f.get('acodec') not in (None,'none') and f.get('protocol') in ('http','https')]
    if not candidates:raise ValueError('VIDEO_AUDIO: no direct HTTP audio stream')
    chosen=min(candidates,key=lambda f:(f.get('vcodec') not in (None,'none'),abs((f.get('abr') or 128)-128)))
    source=RangeReader(ydl.urlopen,chosen['url'],chosen.get('http_headers'))
    path=Path(a['folder'])/'range-audio.wav';written=0
    with av.open(source,mode='r',options={'protocol_whitelist':'file,pipe','format_whitelist':'mov,matroska,webm,ogg'}) as container, wave.open(str(path),'wb') as output:
        stream=container.streams.audio[0];stream.codec_context.thread_count=1
        container.seek(int(start/stream.time_base),stream=stream,backward=True)
        resampler=av.AudioResampler(format='s16',layout='mono',rate=16000)
        output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000)
        def emit(frames):
            nonlocal written
            for frame in frames:
                if frame.time is None:raise ValueError('VIDEO_AUDIO: missing audio timestamps')
                lo=max(0,math.ceil((start-frame.time)*16000));hi=min(frame.samples,math.ceil((end-frame.time)*16000))
                if hi>lo:
                    raw=bytes(frame.planes[0])[lo*2:hi*2];output.writeframesraw(raw);written+=len(raw)
                    if written>600*16000*2:raise ValueError('VIDEO_AUDIO: output limit exceeded')
        for frame in container.decode(stream):
            if frame.time is not None and frame.time>=end:break
            emit(resampler.resample(frame))
        emit(resampler.resample(None))
    if not written:raise ValueError('VIDEO_AUDIO: no audio in window')
    return {'mode':'http-range','transferredBytes':source.transferred,'rangeRequests':source.requests,'sourceBytes':source.size,'audioSeconds':written/32000}
