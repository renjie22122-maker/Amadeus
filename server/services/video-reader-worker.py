"""Read-only platform adapter; JSON stdin, no shell or browser profile access."""
import sys,json,re,socket,ipaddress,urllib.request,urllib.parse,urllib.error,http.cookiejar,time,shutil
from pathlib import Path
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
MAX_BYTES=300*1024*1024

def public_ip(value):
    address=ipaddress.ip_address(value.split('%')[0])
    return address.is_global and not address.is_multicast and not address.is_unspecified

def protect_network():
    original_dns,original_connect=socket.getaddrinfo,socket.socket.connect
    def dns(host,port,*args,**kwargs):
        values=original_dns(host,port,*args,**kwargs)
        if not values or any(not public_ip(v[4][0]) for v in values): raise ValueError('NETWORK_DENIED: non-public destination')
        return values
    def connect(sock,address):
        # Connect to the checked numeric address, without a second DNS lookup.
        values=dns(address[0],address[1],sock.family,sock.type)
        return original_connect(sock,values[0][4])
    socket.getaddrinfo,socket.socket.connect=dns,connect

def platform_url(raw):
    u=urllib.parse.urlsplit(raw)
    if u.scheme!='https' or u.username or u.password or u.port not in (None,443): raise ValueError('VIDEO_URL: public HTTPS required')
    host=(u.hostname or '').lower()
    if host in ('b23.tv','www.bilibili.com','bilibili.com','m.bilibili.com','t.bilibili.com','space.bilibili.com'): return 'bilibili'
    if host in ('www.youtube.com','youtube.com','m.youtube.com','youtu.be','www.youtube-nocookie.com'): return 'youtube'
    raise ValueError('VIDEO_URL: unsupported platform')

def cookie_jar(path,platform):
    jar=http.cookiejar.MozillaCookieJar()
    if path:
        original=http.cookiejar.MozillaCookieJar(path); original.load(ignore_discard=True,ignore_expires=False)
        allowed=('bilibili.com','b23.tv') if platform=='bilibili' else ('youtube.com',)
        for cookie in original:
            domain=cookie.domain.lstrip('.')
            if any(domain==d or domain.endswith('.'+d) for d in allowed): jar.set_cookie(cookie)
    return jar

def opener(jar):
    return urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))

def bili_api(path,query,jar):
    url='https://api.bilibili.com'+path+'?'+urllib.parse.urlencode(query)
    req=urllib.request.Request(url,headers={'User-Agent':UA,'Referer':'https://www.bilibili.com/'})
    for attempt in range(3):
        try:
            with opener(jar).open(req,timeout=20) as response: raw=response.read(8*1024*1024+1)
            break
        except urllib.error.HTTPError as error:
            if error.code not in (429,500,502,503,504) or attempt==2: raise
            time.sleep(min(2**attempt,4))
        except (urllib.error.URLError,TimeoutError,OSError):
            if attempt==2: raise
            time.sleep(min(2**attempt,4))
    if len(raw)>8*1024*1024: raise ValueError('RESPONSE_LIMIT: too large')
    data=json.loads(raw)
    if data.get('code')!=0: raise ValueError('PLATFORM_ACCESS: Bilibili code '+str(data.get('code')))
    return data.get('data') or {}

def bili_identity(url,jar):
    u=urllib.parse.urlsplit(url)
    if u.hostname=='b23.tv':
        with opener(jar).open(urllib.request.Request(url,headers={'User-Agent':UA}),timeout=20) as response: url=response.url
        if platform_url(url)!='bilibili': raise ValueError('VIDEO_URL: invalid redirect')
        u=urllib.parse.urlsplit(url)
    dynamic=re.search(r'/(?:opus/)?(\d+)',u.path) if u.hostname=='t.bilibili.com' or '/opus/' in u.path else None
    if dynamic: return {'dynamic':dynamic[1],'url':url}
    bv=re.search(r'/video/(BV[a-zA-Z0-9]+)',u.path); av=re.search(r'/video/av(\d+)',u.path)
    if not bv and not av: raise ValueError('VIDEO_URL: video or dynamic link required')
    view=bili_api('/x/web-interface/view',{'bvid':bv[1]} if bv else {'aid':av[1]},jar)
    page=int(urllib.parse.parse_qs(u.query).get('p',['1'])[0]); pages=view.get('pages') or []
    if page<1 or page>len(pages): raise ValueError('VIDEO_PART: part does not exist')
    return {'aid':view['aid'],'cid':pages[page-1]['cid'],'url':url,'view':view,'page':page}

def clean_dynamic(item,depth=0):
    modules=item.get('modules') or {}; author=modules.get('module_author') or {}; body=modules.get('module_dynamic') or {}; major=body.get('major') or {}
    draw=major.get('draw') or {}; archive=major.get('archive') or {}; opus=major.get('opus') or {}; article=major.get('article') or {}
    result={'id':item.get('id_str'),'author':{'id':str(author.get('mid','')),'name':author.get('name')},'publishedAt':author.get('pub_ts'),
        'text':(body.get('desc') or {}).get('text') or (opus.get('summary') or {}).get('text') or '',
        'title':archive.get('title') or opus.get('title') or article.get('title'),'videoUrl':archive.get('jump_url'),
        'images':[v.get('src') or v.get('url') for v in (draw.get('items') or opus.get('pics') or [])][:30],'type':item.get('type')}
    if item.get('orig') and depth<2: result['original']=clean_dynamic(item['orig'],depth+1)
    return result

def bili_social(a,jar):
    ident=bili_identity(a['url'],jar)
    if a['action']=='dynamic':
        if 'dynamic' not in ident: raise ValueError('VIDEO_URL: individual dynamic link required')
        item=bili_api('/x/polymer/web-dynamic/v1/detail',{'id':ident['dynamic']},jar).get('item') or {}
        return {'platform':'bilibili','url':a['url'],'dynamic':clean_dynamic(item),'fetchedAt':time.time()}
    if 'dynamic' in ident:
        item=bili_api('/x/polymer/web-dynamic/v1/detail',{'id':ident['dynamic']},jar).get('item') or {}; basic=item.get('basic') or {}
        oid,typ=basic.get('comment_id_str'),basic.get('comment_type')
        if not oid or not typ: raise ValueError('COMMENTS_UNAVAILABLE: no comment target')
    else: oid,typ=ident['aid'],1
    query={'oid':oid,'type':typ,'pn':a.get('page',1),'ps':20,'sort':0 if a.get('sort')=='newest' else 2}
    if a.get('root'): query['root']=a['root']
    data=bili_api('/x/v2/reply/reply' if a.get('root') else '/x/v2/reply',query,jar)
    def clean(r):
        return {'id':r.get('rpid_str',str(r.get('rpid',''))),'parentId':str(r.get('parent',0)),'authorId':str(r.get('mid','')),'author':(r.get('member') or {}).get('uname'),'text':(r.get('content') or {}).get('message',''),'likes':r.get('like'),'publishedAt':r.get('ctime'),'replyCount':r.get('rcount',0)}
    replies=data.get('replies') or []; total=(data.get('page') or {}).get('count')
    more=(len(replies)==20) if total is None else query['pn']*20<total
    return {'platform':'bilibili','url':a['url'],'comments':[clean(r) for r in replies],'totalReported':total,'page':query['pn'],'nextPage':query['pn']+1 if more else None,'sort':a.get('sort','top'),'partial':True,'fetchedAt':time.time()}

def bili_video(a,jar):
    ident=bili_identity(a['url'],jar)
    if 'view' not in ident:raise ValueError('VIDEO_URL: use read_video_social for dynamic posts')
    view=ident['view'];page=view['pages'][ident['page']-1]
    if a['action'] in ('probe','subtitle'):
        subtitle_status='available';tracks=[]
        try:
            data=bili_api('/x/player/v2',{'aid':ident['aid'],'cid':ident['cid']},jar)
            tracks=(data.get('subtitle') or {}).get('subtitles') or []
        except Exception:
            if a['action']=='subtitle':raise
            subtitle_status='unavailable'
        def kind(t):return 'automatic' if t.get('ai_type') or str(t.get('lan','')).startswith('ai-') else 'author'
        def track_id(t):return kind(t)+':'+str(t.get('lan','unknown'))
        if a['action']=='subtitle':
            track=next((t for t in tracks if track_id(t)==a['track']),None)
            if not track:raise ValueError('SUBTITLE_MISSING: refresh video_probe')
            url=track.get('subtitle_url','');url='https:'+url if url.startswith('//') else url
            if url.startswith('http://'):url='https://'+url[7:]
            if urllib.parse.urlsplit(url).scheme!='https':raise ValueError('SUBTITLE_URL: HTTPS required')
            with opener(jar).open(urllib.request.Request(url,headers={'User-Agent':UA,'Referer':'https://www.bilibili.com/'}),timeout=20) as response:raw=response.read(8*1024*1024+1)
            if len(raw)>8*1024*1024:raise ValueError('SUBTITLE_SIZE: too large')
            return {'track':a['track'],'kind':kind(track),'language':track.get('lan'),'format':'json','raw':raw.decode('utf-8-sig')}
        dimension=page.get('dimension') or view.get('dimension') or {}
        return {'platform':'bilibili','url':a['url'],'title':view.get('title'),'id':view.get('bvid'),'duration':page.get('duration'),'author':(view.get('owner') or {}).get('name'),'description':str(view.get('desc') or '')[:6000],'thumbnail':view.get('pic'),'width':dimension.get('width'),'height':dimension.get('height'),'tracks':[{'id':track_id(t),'language':t.get('lan'),'kind':kind(t)} for t in tracks],'subtitleStatus':subtitle_status,'credentialsProvided':bool(len(jar)),'fetchedAt':time.time()}
    play=bili_api('/x/player/playurl',{'avid':ident['aid'],'cid':ident['cid'],'qn':16,'fnval':4048,'fourk':0},jar)
    dash=play.get('dash') or {};formats=[];backups={}
    for typ in ('video','audio'):
        for item in dash.get(typ) or []:
            url=item.get('baseUrl') or item.get('base_url')
            if not url:continue
            backups[url]=(item.get('backupUrl') or item.get('backup_url') or [])[:2]
            formats.append({'url':url,'protocol':urllib.parse.urlsplit(url).scheme,'vcodec':item.get('codecs') if typ=='video' else 'none','acodec':item.get('codecs') if typ=='audio' else 'none','width':item.get('width'),'height':item.get('height'),'tbr':(item.get('bandwidth') or 0)/1000,'abr':(item.get('bandwidth') or 0)/1000,'http_headers':{'User-Agent':UA,'Referer':'https://www.bilibili.com/'}})
    class Transport:
        def urlopen(self,request):
            urls=[request.full_url]+backups.get(request.full_url,[])
            for index,url in enumerate(urls):
                if urllib.parse.urlsplit(url).scheme not in ('http','https'):raise ValueError('VIDEO_URL: invalid media scheme')
                try:return opener(jar).open(urllib.request.Request(url,headers=dict(request.header_items())),timeout=15)
                except (urllib.error.URLError,TimeoutError,OSError):
                    if index==len(urls)-1:raise
    import importlib.util
    spec=importlib.util.spec_from_file_location('video_range',Path(__file__).with_name('video-range.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.remote_frames(a,{'formats':formats},Transport()) if a['action']=='frames' else module.remote_audio(a,{'formats':formats},Transport())

class QuietLog:
    def debug(self,*a): pass
    def warning(self,*a): pass
    def error(self,*a): pass

def extract(a,jar):
    import yt_dlp
    from yt_dlp.globals import plugin_dirs
    plugin_dirs.value=[]
    folder=Path(a['folder']); folder.mkdir(parents=True,exist_ok=True)
    cookies=folder/'session.cookies'; jar.save(str(cookies),ignore_discard=True,ignore_expires=False)
    downloaded={}
    def budget(progress):
        downloaded[progress.get('filename','')]=progress.get('downloaded_bytes',0)
        if sum(downloaded.values())>MAX_BYTES: raise ValueError('VIDEO_SIZE: download exceeds 300 MB')
    opts={'quiet':True,'no_warnings':True,'logger':QuietLog(),'noplaylist':True,'playlistend':1,
        'socket_timeout':20,'retries':2,'fragment_retries':2,'extractor_retries':2,'cachedir':False,
        'cookiefile':str(cookies),'proxy':'','noprogress':True,'progress_hooks':[budget],
        'match_filter':lambda info,**kwargs: 'Live streams are not supported' if info.get('is_live') else None,
        'skip_download':a['action']!='download','outtmpl':str(folder/'video.%(ext)s'),
        'max_filesize':MAX_BYTES,'overwrites':False,'continuedl':True,'ffmpeg_location':shutil.which(a.get('ffmpeg') or 'ffmpeg') or a.get('ffmpeg') or None,
        'format':'best[height<=480][protocol=https]/bestvideo[height<=480][protocol=https]+bestaudio[protocol=https]/best[height<=480][protocol=http]/bestvideo[height<=480][protocol=http]+bestaudio[protocol=http]',
        'merge_output_format':'mp4','postprocessor_args':{'Merger+ffmpeg_i':['-protocol_whitelist','file,pipe']},
        'extractor_args':{'youtube':{'max_comments':[str(min(200,a.get('page',1)*20))],'comment_sort':['new' if a.get('sort')=='newest' else 'top']}}}
    if platform_url(a['url'])=='bilibili': opts['http_headers']={'User-Agent':UA,'Referer':'https://www.bilibili.com/'}
    if a['action']=='comments': opts['getcomments']=True
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info=ydl.extract_info(a['url'],download=a['action']=='download')
            if info.get('_type') in ('playlist','multi_video'):
                entries=list(info.get('entries') or [])
                if not entries: raise ValueError('VIDEO_EMPTY: no entries')
                info=entries[0]
            if info.get('is_live'): raise ValueError('VIDEO_LIVE: live streams are not bounded videos')
            if a['action'] in ('frames','audio'):
                import importlib.util
                spec=importlib.util.spec_from_file_location('video_range',Path(__file__).with_name('video-range.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                return module.remote_frames(a,info,ydl) if a['action']=='frames' else module.remote_audio(a,info,ydl)
            if a['action']=='comments':
                comments=info.get('comments')
                if comments is None: raise ValueError('COMMENTS_UNAVAILABLE: not returned by platform')
                start=(a.get('page',1)-1)*20
                rows=[{k:r.get(k) for k in ('id','parent','author','author_id','text','like_count','timestamp')} for r in comments[start:start+20]]
                return {'platform':'youtube','url':a['url'],'comments':rows,'page':a.get('page',1),'nextPage':a.get('page',1)+1 if len(rows)==20 and a.get('page',1)<10 else None,'partial':True,'sort':a.get('sort','top'),'fetchedAt':time.time()}
            tracks=[]
            for kind,key in [('author','subtitles'),('automatic','automatic_captions')]:
                for language,formats in (info.get(key) or {}).items():
                    formats=[f for f in formats if f.get('ext') in ('json3','json','vtt','srt') and f.get('url')]
                    if formats: tracks.append({'id':kind+':'+language,'language':language,'kind':kind,'formats':formats})
            if a['action']=='subtitle':
                track=next((t for t in tracks if t['id']==a['track']),None)
                if not track: raise ValueError('SUBTITLE_MISSING: refresh video_probe')
                fmt=min(track['formats'],key=lambda f:['json3','json','vtt','srt'].index(f['ext']))
                with ydl.urlopen(fmt['url']) as response: raw=response.read(8*1024*1024+1)
                if len(raw)>8*1024*1024: raise ValueError('SUBTITLE_SIZE: too large')
                return {'track':a['track'],'kind':track['kind'],'language':track['language'],'format':fmt['ext'],'raw':raw.decode('utf-8-sig')}
            path=None
            if a['action']=='download':
                candidates=[p for p in folder.glob('video.*') if p.suffix in ('.mp4','.webm','.mkv','.flv')]
                if not candidates: raise ValueError('VIDEO_DOWNLOAD: no complete video file')
                path=str(max(candidates,key=lambda p:p.stat().st_size))
            return {'platform':platform_url(a['url']),'url':a['url'],'title':info.get('title'),'id':info.get('id'),'duration':info.get('duration'),'author':info.get('uploader'),'description':str(info.get('description') or '')[:6000],'thumbnail':info.get('thumbnail'),'width':info.get('width'),'height':info.get('height'),'tracks':[{k:t[k] for k in ('id','language','kind')} for t in tracks],'path':path,'credentialsProvided':bool(len(jar)),'fetchedAt':time.time()}
    finally: cookies.unlink(missing_ok=True)

def main(a):
    if a.get('action') not in ('probe','subtitle','frames','audio','comments','dynamic'):raise ValueError('VIDEO_ACTION: unsupported read operation')
    platform=platform_url(a['url']); protect_network(); jar=cookie_jar(a.get('cookiesFile'),platform)
    if platform=='bilibili' and a['action'] in ('comments','dynamic'): return bili_social(a,jar)
    if platform=='bilibili' and a['action'] in ('probe','subtitle','frames','audio'): return bili_video(a,jar)
    return extract(a,jar)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdin.reconfigure(encoding='utf-8-sig')
    try: print(json.dumps({'ok':True,'data':main(json.loads(sys.stdin.read()))},ensure_ascii=False))
    except Exception as e:
        msg=str(e)
        if isinstance(e,ModuleNotFoundError): code='VIDEO_DEPENDENCY'; detail='Install yt-dlp, av and Pillow in the configured video-reader Python environment.'
        elif any(s in msg.lower() for s in ('sign in','login','cookie','412','403','429','567')): code='VIDEO_ACCESS'; detail='Site requires login, denies the request or rate limits access. Configure a local account or retry later.'
        elif any(s in msg.lower() for s in ('timed out','timeout','connection','unable to download')): code='VIDEO_NETWORK'; detail='Platform request failed or timed out; check network access.'
        elif any(v in msg.lower() for v in ('unavailable','private video','deleted','geo-restricted')): code='VIDEO_UNAVAILABLE'; detail='The platform reports this video is unavailable or private.'
        else: code=msg.split(':')[0] if re.match(r'^[A-Z_]+:',msg) and not msg.startswith('ERROR:') else 'VIDEO_EXTRACT'; detail='Video reader failed ('+type(e).__name__+'); check adapter version and source availability.'
        status=re.search(r'HTTP Error (\d{3})',msg); platform_code=re.search(r'Bilibili code (-?\d+)',msg)
        print(json.dumps({'ok':False,'code':code,'error':detail,'httpStatus':int(status[1]) if status else None,'platformCode':int(platform_code[1]) if platform_code else None})); sys.exit(1)
