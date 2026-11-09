"""Read-only archive inventory / bounded member bytes. Never writes archive paths."""
import sys, json, base64, stat
LIMIT = 2 * 1024 * 1024
SCAN = 128 * 1024 * 1024

def safe(name):
    p = name.replace('\\', '/')
    return not (p.startswith('/') or ':' in p or '..' in p.split('/'))

def inspect(path, member):
    import libarchive
    rows, scanned = [], 0
    with libarchive.file_reader(path) as archive:
        for ordinal, entry in enumerate(archive):
            if ordinal >= 10000:
                return {'entries': rows, 'truncated': True, 'reason': 'entry-budget'}
            name = entry.pathname
            regular = stat.S_ISREG(entry.mode) and not entry.linkpath
            allowed = safe(name) and regular
            size = entry.size or 0
            if member is None:
                rows.append({'name': name, 'size': size, 'readable': allowed, 'directory': stat.S_ISDIR(entry.mode)})
                if len(rows) >= 1000:
                    return {'entries': rows, 'truncated': True}
            elif name == member:
                if not allowed: raise ValueError('Unsafe path or link member refused')
                if size > LIMIT: raise ValueError('Member exceeds bounded read size')
                data = bytearray()
                for block in entry.get_blocks():
                    data.extend(block)
                    if len(data) > LIMIT: raise ValueError('Member exceeds bounded read size')
                return {'name':name, 'bytesBase64':base64.b64encode(data).decode('ascii')}
            scanned += size
            if scanned > SCAN: raise ValueError('Archive scan budget exceeded; select a smaller archive')
    if member is not None: raise ValueError('Member not found')
    return {'entries':rows, 'truncated':False}

try:
    print(json.dumps(inspect(sys.argv[1], sys.argv[2] if len(sys.argv)>2 else None),ensure_ascii=True))
except ImportError:
    print(json.dumps({'error':'ARCHIVE_DECODER_UNAVAILABLE: install libarchive-c and the libarchive runtime in the configured Python environment'}))
except Exception as exc:
    print(json.dumps({'error':type(exc).__name__ + ': archive unreadable, encrypted, unsafe or over inspection limits'}))
