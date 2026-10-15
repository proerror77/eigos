import json,sys,uuid,urllib.request,time
D="/Users/proerror/Documents/eigo8/data/live-a2a-20261015/"
c=json.load(open(D+"client.json"));B=c["baseUrl"].rstrip("/");T=c["token"]
def log(o):
    with open(D+"grok-peer-transcript.jsonl","a") as f: f.write(json.dumps(o,ensure_ascii=False)+"\n")
def req(method,url,body=None):
    h={"A2A-Version":"1.0","Content-Type":"application/json","Authorization":"Bearer "+T}
    data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None
    log({"ts":time.time(),"dir":"request","method":method,"url":url,"headers":{"A2A-Version":"1.0","Content-Type":"application/json","Authorization":"Bearer [REDACTED]"},"body":body})
    r=urllib.request.Request(url,data=data,method=method,headers=h)
    try:
        with urllib.request.urlopen(r,timeout=120) as resp: st=resp.status;txt=resp.read().decode()
    except urllib.error.HTTPError as e: st=e.code;txt=e.read().decode()
    try: j=json.loads(txt)
    except Exception: j=txt
    log({"ts":time.time(),"dir":"response","status":st,"body":j})
    return st,j
cmd=sys.argv[1]
if cmd=="card": out=req("GET",B+"/.well-known/agent-card.json")
elif cmd=="goal":
    out=req("POST",B+"/a2a",{"jsonrpc":"2.0","id":str(uuid.uuid4()),"method":"SendMessage","params":{"message":{"messageId":str(uuid.uuid4()),"role":"ROLE_USER","parts":[{"data":{"service":"agent.execute","goal":"请为一家香港中小企业设计 AI 客户咨询处理工作坊。先确认影响方案的必要条件，再交付可执行议程和练习。"}}]},"configuration":{"returnImmediately":True}}})
elif cmd=="get": out=req("POST",B+"/a2a",{"jsonrpc":"2.0","id":str(uuid.uuid4()),"method":"GetTask","params":{"id":sys.argv[2]}})
elif cmd=="poll":
    while True:
        out=req("POST",B+"/a2a",{"jsonrpc":"2.0","id":str(uuid.uuid4()),"method":"GetTask","params":{"id":sys.argv[2]}})
        s=json.dumps(out[1]).upper()
        st=((out[1].get("result") or {}).get("status") or {}).get("state","") if isinstance(out[1],dict) else ""
        if "WORKING" not in st and "SUBMITTED" not in st: break
        time.sleep(5)
elif cmd=="reply":
    txt=open(sys.argv[3]).read()
    out=req("POST",B+"/a2a",{"jsonrpc":"2.0","id":str(uuid.uuid4()),"method":"SendMessage","params":{"message":{"messageId":str(uuid.uuid4()),"taskId":sys.argv[2],"role":"ROLE_USER","parts":[{"text":txt}]},"configuration":{"returnImmediately":True}}})
print(json.dumps(out,ensure_ascii=False,indent=1))
