"""Staff chat authorization/attachment/read-state integration, isolated port 18083 only.
Temporarily adds disposable test accounts, restores the exact privilege list in finally.
"""
import http.cookiejar,json,sys,urllib.request,urllib.error,urllib.parse,uuid
from _guard import base_url
B=base_url(sys.argv[1] if len(sys.argv)>1 else 'http://localhost:18083')
assert urllib.parse.urlsplit(B).port==18083,'Isolated UI stack only'
def client(email):
    op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B+'/auth/dev-login?email='+email,timeout=15).close()
    return op
def call(op,path,data=None):
    req=urllib.request.Request(B+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    try:
        with op.open(req,timeout=15) as r:
            raw=r.read();return r.status,json.loads(raw) if 'application/json' in r.headers.get('Content-Type','') else raw
    except urllib.error.HTTPError as e:return e.code,e.read()
def upload(op,name,body):
    boundary='staff-test-boundary'
    data=('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="'+name+'"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()+body+('\r\n--'+boundary+'--\r\n').encode()
    req=urllib.request.Request(B+'/api/staff/upload',data=data,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
    try:
        with op.open(req,timeout=15) as r:return r.status,json.loads(r.read())
    except urllib.error.HTTPError as e:return e.code,e.read()
n=0
def check(name,value):
    global n
    assert value,name
    n+=1;print('PASS',name)
owner=client('');code,original=call(owner,'/api/admin/privilegs-users/get-list');assert code==200
token=uuid.uuid4().hex[:10]
emails={r:'staff-'+r+'-'+token+'@example.test' for r in ['writer','reviewer','moderator','admin','reader']}
fixtures=[{'email':email,'username':role,'publicName':'Test '+role,'privileges':{role:True}} for role,email in emails.items() if role!='reader']
anon=urllib.request.build_opener()
try:
    assert call(owner,'/api/admin/privilegs-users/set',{'list':original+fixtures})[0]==200
    users={r:client(e) for r,e in emails.items()}
    a=users['writer'];b=users['reviewer'];a2=client(emails['writer'])
    for endpoint in ['messages','summary']:
        check('anonymous blocked '+endpoint,call(anon,'/api/staff/'+endpoint)[0]==401)
        check('reader blocked '+endpoint,call(users['reader'],'/api/staff/'+endpoint)[0]==403)
    for role in ['writer','reviewer','moderator','admin']:
        check(role+' can access shared room',call(users[role],'/api/staff/messages')[0]==200)
    check('reader cannot upload',upload(users['reader'],'test.txt',b'test')[0]==403)
    check('direct admin page exists',call(owner,'/admin')[0]==200)
    check('writer cannot review media',call(a,'/api/admin/hold/waiting')[0] in (401,403))
    check('reviewer cannot read contacts',call(b,'/api/admin/contact')[0] in (401,403))
    check('admin-only cannot read contacts',call(users['admin'],'/api/admin/contact')[0] in (401,403))
    latest=call(b,'/api/staff/summary')[1]['latest'];call(b,'/api/staff/seen',{'upTo':latest})
    code,m=call(a,'/api/staff/messages',{'text':'Isolated staff test '+token,'files':[]})
    check('writer sends text',code==200 and m['text'].endswith(token) and m['name']=='Test writer')
    check('reviewer receives unread',call(b,'/api/staff/summary')[1]['unread']==1)
    call(b,'/api/staff/messages')
    check('fetch alone does not mark read',call(b,'/api/staff/summary')[1]['unread']==1)
    call(b,'/api/staff/seen',{'upTo':m['id']});check('explicit seen clears',call(b,'/api/staff/summary')[1]['unread']==0)
    call(b,'/api/staff/seen',{'upTo':0});check('seen cannot move backwards',call(b,'/api/staff/summary')[1]['unread']==0)
    call(a2,'/api/staff/seen',{'upTo':m['id']});check('seen follows account',call(a,'/api/staff/summary')[1]['unread']==0)
    check('empty message rejected',call(a,'/api/staff/messages',{'text':'','files':[]})[0]==400)
    check('oversized text rejected',call(a,'/api/staff/messages',{'text':'a'*2001})[0]==400)
    code,f=upload(a,'staff-test.txt',b'Isolated staff attachment');check('upload',code==200)
    path='/api/staff/files/'+f['id']
    check('unpublished attachment hidden from other staff',call(b,path)[0]==404)
    check('attachment visible to uploader',call(a,path)[0]==200)
    check('another staff cannot attach uploaded file',call(b,'/api/staff/messages',{'text':'','files':[f['id']]})[0]==404)
    code,attached=call(a,'/api/staff/messages',{'text':'','files':[f['id']]});check('file only message',code==200 and len(attached['files'])==1)
    check('published attachment shared with staff',call(b,path)[0]==200)
    check('attachment hidden from readers',call(users['reader'],path)[0]==403)
    check('attachment hidden anonymously',call(anon,path)[0]==401)
    check('attachment cannot be reused',call(a,'/api/staff/messages',{'text':'again','files':[f['id']]})[0]==404)
    check('attachment cannot use public file route',call(users['reader'],'/api/files/'+f['id'])[0] in (400,404))
    check('after cursor returns ordered next messages',all(x['id']>m['id'] for x in call(b,'/api/staff/messages?after='+str(m['id']))[1]))
    check('before cursor excludes cursor',all(x['id']<attached['id'] for x in call(b,'/api/staff/messages?before='+str(attached['id']))[1]))
    preferences={k:False for k in ['replyToast','chatToast','inboxToast','mediaToast','broadcastToast']}
    check('all notification preferences stored',call(a,'/api/my/preferences',preferences)==(200,preferences))
    check('notification preferences shared across devices',call(a2,'/api/my/preferences')==(200,preferences))
    assert call(owner,'/api/admin/privilegs-users/set',{'list':original})[0]==200
    check('revoked session loses chat',call(a,'/api/staff/messages')[0]==403)
    check('revoked session loses attachment',call(a,path)[0]==403)
finally:
    assert call(owner,'/api/admin/privilegs-users/set',{'list':original})[0]==200,'Could not restore original local privileges'
print(str(n)+' checks passed; original privileges restored')
