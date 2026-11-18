"""Private desktop fixture. Grant only the live bootstrap's package SID."""
import ctypes as c
from ctypes import wintypes as w
import json
import pathlib
import subprocess
import sys
import uuid
import win32api, win32con, win32event, win32process, win32security as security, win32service
import pywintypes

def grant(name, pid):
    process = win32api.OpenProcess(0x1000, False, pid)
    token = security.OpenProcessToken(process, win32con.TOKEN_QUERY)
    query = c.windll.advapi32.GetTokenInformation
    query.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)]
    needed = w.DWORD()
    query(int(token), 31, None, 0, c.byref(needed))
    if not 0 < needed.value <= 65536:
        raise RuntimeError("Missing package identity")
    buf = c.create_string_buffer(needed.value)
    if not query(int(token),31,buf,len(buf),c.byref(needed)): raise c.WinError()
    address = c.c_void_p.from_buffer(buf).value
    text = w.LPWSTR()
    if not address or not c.windll.advapi32.ConvertSidToStringSidW(c.c_void_p(address),c.byref(text)): raise c.WinError()
    sid = text.value
    c.windll.kernel32.LocalFree(c.cast(text,c.c_void_p))
    import re
    if not re.fullmatch(r"S-1-15-2-(?:[0-9]+-){6}[0-9]+",sid): raise RuntimeError("Expected a specific package SID")
    desk = win32service.OpenDesktop(name,0,False,win32con.READ_CONTROL|win32con.WRITE_DAC)
    sd = security.GetUserObjectSecurity(desk,security.DACL_SECURITY_INFORMATION)
    acl = sd.GetSecurityDescriptorDacl()
    if acl.GetAceCount()!=1: raise RuntimeError("Unexpected initial ACL")
    acl.AddAccessAllowedAce(security.ACL_REVISION,0x200c7,security.ConvertStringSidToSid(sid))
    sd.SetSecurityDescriptorDacl(True,acl,False)
    security.SetUserObjectSecurity(desk,security.DACL_SECURITY_INFORMATION,sd)

def main(node,entry,request,title,output, *, runtime=False):
    name='Amadeus'+uuid.uuid4().hex
    token=security.OpenProcessToken(win32api.GetCurrentProcess(),win32con.TOKEN_QUERY)
    user=security.ConvertSidToStringSid(security.GetTokenInformation(token,security.TokenUser)[0])
    sa=pywintypes.SECURITY_ATTRIBUTES()
    sa.SECURITY_DESCRIPTOR=security.ConvertStringSecurityDescriptorToSecurityDescriptor('D:P(A;;GA;;;'+user+')',1)
    desk=win32service.CreateDesktop(name,0,win32con.GENERIC_ALL,sa)
    si=win32process.STARTUPINFO()
    si.lpDesktop=name
    args=[node,str(pathlib.Path(__file__).with_name('mxc-command-broker.mjs' if runtime else 'mxc-desktop-test-broker.mjs')),entry,request,name,title,output,sys.executable]
    import win32job
    job=win32job.CreateJobObject(None,"Amadeus-"+uuid.uuid4().hex)
    limits=win32job.QueryInformationJobObject(job,win32job.JobObjectExtendedLimitInformation)
    limits['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    win32job.SetInformationJobObject(job,win32job.JobObjectExtendedLimitInformation,limits)
    proc,thread,_,_=win32process.CreateProcess(node,subprocess.list2cmdline(args),None,None,False,win32con.CREATE_NO_WINDOW|win32con.CREATE_SUSPENDED,None,None,si)
    try:
        try:
            win32job.AssignProcessToJobObject(job,proc)
            win32process.ResumeThread(thread)
        except BaseException:
            win32process.TerminateProcess(proc,1)
            raise
        timeout=json.loads(pathlib.Path(request).read_text(encoding='utf-8-sig')).get('timeoutMs',15000)
        if win32event.WaitForSingleObject(proc,timeout+15000)!=0:
            win32process.TerminateProcess(proc,1)
            raise RuntimeError('broker timed out')
        if win32process.GetExitCodeProcess(proc)!=0: raise RuntimeError('broker failed')
    finally:
        job.Close()
        desk.CloseDesktop()

if __name__=='__main__':
    if sys.argv[1]=='grant': grant(sys.argv[2],int(sys.argv[3]))
    elif sys.argv[1]=='execute': main(*sys.argv[2:],runtime=True)
    else: main(*sys.argv[1:])

