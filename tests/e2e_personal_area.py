"""Account isolation and synchronization, only on the isolated local UI stack.
Creates disposable reader sessions and saved/preferences records, never edits posts.
Usage: python tests/e2e_personal_area.py http://localhost:18083
"""
import concurrent.futures
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
import uuid
from _guard import base_url

B = base_url(sys.argv[1] if len(sys.argv)>1 else 'http://localhost:18083')
if urllib.parse.urlsplit(B).port != 18083:
    raise SystemExit('This test is restricted to the isolated UI stack on port 18083')

def client(email):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(B+'/auth/dev-login?email='+email,timeout=15).close()
    return op

def call(op,path,data=None):
    req=urllib.request.Request(B+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    try:
        with op.open(req,timeout=15) as r:
            raw=r.read(); return r.status,json.loads(raw) if 'application/json' in r.headers.get('Content-Type','') else raw
    except urllib.error.HTTPError as e: return e.code,e.read()

count=0
def check(name,condition):
    global count
    assert condition,name
    count+=1; print('PASS',name)

token=uuid.uuid4().hex[:10]
a=client('personal-a-'+token+'@example.test')
a2=client('personal-a-'+token+'@example.test')
b=client('personal-b-'+token+'@example.test')
anon=urllib.request.build_opener()
for path in ['/api/my/saved','/api/my/preferences']:
    check('anonymous rejected '+path,call(anon,path)[0]==401)
check('direct personal route',call(a,'/my-messages')[0]==200)
check('initial list is empty',call(a,'/api/my/saved')==(200,[]))
status,messages=call(a,'/api/messages?limit=20&poll=1')
created=[]
if status==200 and isinstance(messages,list) and len(messages)<2:
    owner=client('')
    _,config=call(owner,'/api/channel/notifications-config')
    _,settings=call(owner,'/api/admin/settings/get')
    assert not config['enableNotifications'],'Refusing fixture posts while Push is enabled'
    assert isinstance(settings,list) and not any(x.get('key')=='webhook_url' and x.get('value') for x in settings),'Refusing fixture posts with webhook enabled'
    for n in range(2):
        code,msg=call(owner,'/api/admin/new',{'type':'md','text':'Personal area test fixture '+token+' '+str(n)})
        assert code==200,'Could not create local fixture'
        created.append(msg['id'])
    status,messages=call(a,'/api/messages?limit=20&poll=1')
assert status==200 and isinstance(messages,list) and len(messages)>=2,'Need two existing reader-visible fixture messages'
ids=[m['id'] for m in messages[:2]]
try:
    check('add first',call(a,'/api/my/saved',{'action':'add','ids':[ids[0]]})[0]==200)
    check('same account on another device',call(a2,'/api/my/saved')[1][0]['id']==ids[0])
    check('other account remains empty',call(b,'/api/my/saved')[1]==[])
    check('cannot select another account with query',call(b,'/api/my/saved?user=personal-a-'+token)[1]==[])
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        list(pool.map(lambda p:call(p[0],'/api/my/saved',{'action':'add','ids':[p[1]]}),[(a,ids[0]),(a2,ids[1])]))
    check('concurrent additions retained',set(x['id'] for x in call(a,'/api/my/saved')[1])==set(ids))
    check('remove',call(a2,'/api/my/saved',{'action':'remove','ids':[ids[0]]})[0]==200)
    check('removal synchronized',[x['id'] for x in call(a,'/api/my/saved')[1]]==[ids[1]])
    check('invalid action',call(a,'/api/my/saved',{'action':'replace','ids':[]})[0]==400)
    check('invalid id',call(a,'/api/my/saved',{'action':'add','ids':[-1]})[0]==400)
    check('batch limit',call(a,'/api/my/saved',{'action':'add','ids':[ids[0]]*301})[0]==400)
    check('unknown message does not create entry',call(a,'/api/my/saved',{'action':'add','ids':[2147483647]})[0]==200 and len(call(a,'/api/my/saved')[1])==1)
    check('default reply preference',call(a,'/api/my/preferences')[1]['replyToast'] is True)
    check('save preference',call(a,'/api/my/preferences',{'replyToast':False})[0]==200)
    check('preference follows account',call(a2,'/api/my/preferences')[1]['replyToast'] is False)
    check('preference isolated',call(b,'/api/my/preferences')[1]['replyToast'] is True)
    check('unknown preference rejected',call(a,'/api/my/preferences',{'admin':True})[0]==400)
finally:
    call(a,'/api/my/saved',{'action':'clear','ids':[]})
    call(a,'/api/my/preferences',{'replyToast':True})
    for id in created: call(owner,'/api/admin/delete-message/'+str(id))
check('clear synchronized',call(a2,'/api/my/saved')[1]==[])
print(str(count)+' checks passed')
