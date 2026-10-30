import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { State, hash } from "../src/state";
import { createBridge } from "../src/app";
import { initialize, certificatePin } from "../src/config";
import type { HostBackend, TerminalFrame, TerminalHandle } from "../src/backend/types";
import { BackendError } from "../src/backend/types";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function directory(){const d=mkdtempSync(join(tmpdir(),"herdr-core-"));cleanup.push(()=>rmSync(d,{recursive:true,force:true}));return d;}
class MockBackend implements HostBackend {
  identityToken="identity-1";submitted=0;mutated=0;controllers=0;observers=0;closed=0;commands:unknown[]=[];ambiguous=false;gate?:Promise<void>;
  async snapshot(){return {agents:[],shellPanes:[],workspaces:[],tabs:[],sessions:[],capabilities:{terminal:true}};}
  async identity(_session:string|undefined,paneId:string){return {paneId,identityToken:this.identityToken,revision:1};}
  async output(){return {paneId:"p",text:"output",truncated:false,revision:1,identityToken:this.identityToken};}
  async transcript(){return {supported:false,messages:[]};}
  async git(){return {isRepo:false,files:[]};}async diff(){return {patch:"",truncated:false};}async files(){return {entries:[]};}async file(){return {content:"hello"};}
  async terminal(o:Parameters<HostBackend["terminal"]>[0]):Promise<TerminalHandle>{if(o.control)this.controllers++;else this.observers++;let open=true;
    queueMicrotask(()=>{if(open)o.onFrame({type:"pane_frame",paneId:o.paneId,identityToken:this.identityToken,seq:1,full:true,width:80,height:24,bytes:Buffer.from("terminal").toString("base64")});});
    return {command:async value=>{this.commands.push(value);},close:()=>{if(open){open=false;this.closed++;o.onClose("released");}}};
  }
  async submitText(){this.submitted++;if(this.gate)await this.gate;if(this.ambiguous)throw new BackendError("delivery_unknown","sensitive payload must never be returned",503,true);return {admitted:true};}
  async mutate(){this.mutated++;return {created:true};}close(){}
}
function fixture(options:{leaseMilliseconds?:number}={}){
  const dir=directory(),state=new State(dir,true),backend=new MockBackend();
  const bridge=createBridge({state,backend,...options});cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
  const base=bridge.server.url.origin;
  function device(scope:"read"|"control"="control"){const invite=state.invite(scope);return state.pair(invite.code,"Test device");}
  async function request(path:string,token?:string,method="GET",value?:unknown){return fetch(`${base}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(value!==undefined?{"Content-Type":"application/json"}:{})},body:value===undefined?undefined:JSON.stringify(value)});}
  async function lease(token:string){const r=await request("/v1/panes/p/control",token,"POST",{identityToken:backend.identityToken,takeover:false});expect(r.status).toBe(200);return await r.json() as {leaseId:string,expiresAt:string};}
  return {dir,state,backend,bridge,base,device,request,lease};
}
async function eventually(check:()=>boolean,timeout=2500){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error("Timed out");await Bun.sleep(10);}}
async function socket(base:string,token:string){const ws=new WebSocket(base.replace(/^http/,"ws")+"/v1/live",{headers:{Authorization:`Bearer ${token}`}});const messages:any[]=[];ws.addEventListener("message",event=>messages.push(JSON.parse(event.data as string)));await new Promise<void>((resolve,reject)=>{ws.addEventListener("open",()=>resolve(),{once:true});ws.addEventListener("error",()=>reject(new Error("WebSocket failed")),{once:true});});cleanup.push(()=>ws.close());return {ws,messages};}

describe("durable enrollment",()=>{
  test("one invitation pairs exactly one concurrent caller; secrets are hashed",async()=>{
    const f=fixture(),invite=f.state.invite("control");
    const responses=await Promise.all(Array.from({length:8},()=>f.request("/v1/pair",undefined,"POST",{code:invite.code,name:"Phone"})));
    expect(responses.filter(r=>r.status===201)).toHaveLength(1);expect(responses.filter(r=>r.status===410)).toHaveLength(7);
    const paired=await responses.find(r=>r.status===201)!.json() as {token:string};
    const row=f.state.db.query("SELECT digest FROM devices").get() as {digest:string};expect(row.digest).toBe(hash(paired.token));
    expect(readFileSync(f.state.path).includes(Buffer.from(paired.token))).toBe(false);expect(readFileSync(f.state.path).includes(Buffer.from(invite.code))).toBe(false);
    expect(statSync(f.dir).mode&0o777).toBe(0o700);expect(statSync(f.state.path).mode&0o777).toBe(0o600);
  });
  test("expiry, read scope, origin policy, URL token denial, and bounded bodies",async()=>{
    const f=fixture(),d=f.device("read"),invite=f.state.invite("read");f.state.db.query("UPDATE invitations SET expires=0").run();
    expect((await f.request("/v1/pair",undefined,"POST",{code:invite.code,name:"Phone"})).status).toBe(410);
    expect((await f.request("/v1/snapshot",d.token)).status).toBe(200);
    expect((await f.request("/v1/panes/p/control",d.token,"POST",{identityToken:"identity-1"})).status).toBe(403);
    expect((await fetch(f.base+"/v1/snapshot",{headers:{Origin:"https://evil.example",Authorization:`Bearer ${d.token}`}})).status).toBe(403);
    expect((await f.request(`/v1/snapshot?token=${d.token}`)).status).toBe(401);
    expect((await f.request("/v1/pair",undefined,"POST",{code:"x".repeat(70_000),name:"Phone"})).status).toBe(413);
    expect(await (await f.request("/health")).json()).toEqual({protocolVersion:1,available:true});
  });
});
describe("explicit and revocable control",()=>{
  test("observation never starts a controller; only explicit takeover changes ownership",async()=>{
    const f=fixture(),a=f.device(),b=f.device(),s=await socket(f.base,a.token);
    s.ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",cols:80,rows:24}));
    await eventually(()=>s.messages.some(m=>m.type==="pane_frame"));expect(f.backend.controllers).toBe(0);expect(f.backend.observers).toBe(1);
    const lease=await f.lease(a.token);expect(f.backend.controllers).toBe(1);expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now());
    const conflict=await f.request("/v1/panes/p/control",b.token,"POST",{identityToken:"identity-1",takeover:false});expect(conflict.status).toBe(409);
    const takeover=await f.request("/v1/panes/p/control",b.token,"POST",{identityToken:"identity-1",takeover:true});expect(takeover.status).toBe(200);expect(f.backend.controllers).toBe(2);
    expect((await f.request(`/v1/control/${lease.leaseId}/renew`,a.token,"POST")).status).toBe(410);
  });
  test("revocation closes a live socket and lease, including revocation from another CLI process",async()=>{
    const f=fixture(),a=f.device(),s=await socket(f.base,a.token);await f.lease(a.token);
    const separate=new State(f.dir,false);separate.revoke(a.deviceId);separate.close();
    await eventually(()=>s.ws.readyState===WebSocket.CLOSED);
    expect(f.bridge.controls.leases.size).toBe(0);expect((await f.request("/v1/snapshot",a.token)).status).toBe(401);
  });
  test("expired or stale-identity control never admits input",async()=>{
    const f=fixture({leaseMilliseconds:30}),a=f.device(),lease=await f.lease(a.token);await Bun.sleep(40);
    const response=await f.request("/v1/panes/p/input",a.token,"POST",{requestId:randomUUID(),leaseId:lease.leaseId,identityToken:"identity-1",text:"no"});expect(response.status).toBe(410);expect(f.backend.submitted).toBe(0);
    const fresh=await f.lease(a.token);f.backend.identityToken="identity-2";
    expect((await f.request("/v1/panes/p/input",a.token,"POST",{requestId:randomUUID(),leaseId:fresh.leaseId,identityToken:"identity-1",text:"no"})).status).toBe(409);expect(f.backend.submitted).toBe(0);
  });
});
describe("durable mutation admission",()=>{
  test("concurrent replay dispatches once; changed body conflicts; operation is device scoped",async()=>{
    const f=fixture(),a=f.device(),b=f.device(),lease=await f.lease(a.token),id=randomUUID();
    let release!:()=>void;f.backend.gate=new Promise(resolve=>{release=resolve;});
    const value={requestId:id,leaseId:lease.leaseId,identityToken:"identity-1",text:"sensitive prompt",submit:true};
    const pending=f.request("/v1/panes/p/input",a.token,"POST",value);await eventually(()=>f.backend.submitted===1);
    const replay=await f.request("/v1/panes/p/input",a.token,"POST",value);expect(replay.status).toBe(202);expect((await replay.json() as any).state).toBe("pending");
    expect((await f.request("/v1/panes/p/input",a.token,"POST",{...value,text:"different"})).status).toBe(409);
    release();expect((await (await pending).json() as any).state).toBe("accepted");
    expect((await (await f.request("/v1/panes/p/input",a.token,"POST",value)).json() as any).state).toBe("accepted");expect(f.backend.submitted).toBe(1);
    expect((await f.request(`/v1/operations/${id}`,b.token)).status).toBe(404);
    expect(readFileSync(f.state.path).includes(Buffer.from(value.text))).toBe(false);
  });
  test("ambiguous dispatch is persisted unknown and never replayed",async()=>{
    const f=fixture(),a=f.device(),lease=await f.lease(a.token);f.backend.ambiguous=true;
    const value={requestId:randomUUID(),leaseId:lease.leaseId,identityToken:"identity-1",text:"no duplicates"};
    const failure=await f.request("/v1/panes/p/input",a.token,"POST",value);expect(failure.status).toBe(503);expect(await failure.text()).not.toContain("sensitive payload");
    const result=await (await f.request("/v1/panes/p/input",a.token,"POST",value)).json() as any;expect(result.state).toBe("unknown");expect(f.backend.submitted).toBe(1);
  });
  test("restart converts pending to unknown while administrative access preserves pending",()=>{
    const dir=directory(),state=new State(dir),a=state.pair(state.invite("control").code,"Device"),id=randomUUID();state.begin(a.deviceId,id,hash("body"));state.close();
    const admin=new State(dir,false);expect(admin.operation(a.deviceId,id).state).toBe("pending");admin.close();
    const restarted=new State(dir,true);expect(restarted.operation(a.deviceId,id).state).toBe("unknown");expect(restarted.begin(a.deviceId,id,hash("body")).fresh).toBe(false);restarted.close();
  });
  test("structural pane writes require exact identity and accept a durable UUID",async()=>{
    const f=fixture(),a=f.device();
    expect((await f.request("/v1/panes/p/split",a.token,"POST",{requestId:randomUUID(),identityToken:"old",direction:"right"})).status).toBe(409);expect(f.backend.mutated).toBe(0);
    const response=await f.request("/v1/panes/p/split",a.token,"POST",{requestId:randomUUID(),identityToken:"identity-1",direction:"down"});expect(response.status).toBe(200);expect((await response.json() as any).state).toBe("accepted");expect(f.backend.mutated).toBe(1);
  });
});
test("real HTTPS enrollment uses a hostname-valid certificate and correct full-leaf fingerprint",async()=>{
  const dir=directory(),config=await initialize(dir,{url:"https://localhost:8443",sans:["127.0.0.1"]}),state=new State(dir),backend=new MockBackend();
  const bridge=createBridge({state,backend,hostname:"127.0.0.1",port:0,tls:{cert:Bun.file(config.certificate),key:Bun.file(config.key)}});cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
  const invitation=state.invite("read");
  const response=await fetch(`https://127.0.0.1:${bridge.server.port}/v1/pair`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:invitation.code,name:"TLS Phone"}),tls:{ca:readFileSync(config.certificate),rejectUnauthorized:true}});
  expect(response.status).toBe(201);expect(certificatePin(config.certificate)).toMatch(/^[0-9a-f]{64}$/);expect(statSync(config.key).mode&0o777).toBe(0o600);
});

test("a queued operation marked unknown cannot dispatch after its queue unlocks",async()=>{
  const f=fixture(),a=f.device(),lease=await f.lease(a.token);let release!:()=>void;
  f.backend.gate=new Promise(resolve=>{release=resolve;});
  const make=(id:string)=>({requestId:id,leaseId:lease.leaseId,identityToken:"identity-1",text:"queued"});
  const first=f.request("/v1/panes/p/input",a.token,"POST",make(randomUUID()));await eventually(()=>f.backend.submitted===1);
  const id=randomUUID(),second=f.request("/v1/panes/p/input",a.token,"POST",make(id));
  await eventually(()=>{try{return f.state.operation(a.deviceId,id).state==="pending";}catch{return false;}});
  f.state.finish(a.deviceId,id,"unknown",{deliveryAmbiguous:true});release();await first;
  expect((await second).status).toBe(503);expect(f.backend.submitted).toBe(1);expect(f.state.operation(a.deviceId,id).state).toBe("unknown");
});

test("revocation during the final identity check prevents new input dispatch",async()=>{
  const f=fixture(),a=f.device(),lease=await f.lease(a.token);let release!:()=>void,entered=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.backend.identity=async(_session,paneId)=>{entered=true;await gate;return {paneId,identityToken:"identity-1",revision:1};};
  const pending=f.request("/v1/panes/p/input",a.token,"POST",{requestId:randomUUID(),leaseId:lease.leaseId,identityToken:"identity-1",text:"revoked"});
  await eventually(()=>entered);f.bridge.revoke(a.deviceId);release();expect((await pending).status).toBe(410);expect(f.backend.submitted).toBe(0);
});

test("controller cache overflow preserves lease and resubscribes with a fresh full observer frame",async()=>{
  const f=fixture(),a=f.device();
  const original=f.backend.terminal.bind(f.backend);let emit:((frame:TerminalFrame)=>void)|undefined;
  f.backend.terminal=async options=>{if(options.control)emit=options.onFrame;return original(options);};
  const lease=await f.lease(a.token);
  for(let seq=2;seq<=520;seq++)emit!({type:"pane_frame",paneId:"p",identityToken:"identity-1",seq,full:false,width:80,height:24,bytes:"eA=="});
  expect(f.bridge.controls.leases.size).toBe(1);expect(f.bridge.controls.get(lease.leaseId,a.deviceId).frames).toHaveLength(0);
  const s=await socket(f.base,a.token);s.ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",leaseId:lease.leaseId,cols:80,rows:24}));
  await eventually(()=>s.messages.some(m=>m.type==="pane_frame" && m.full));expect(f.backend.observers).toBe(1);
  const response=await f.request("/v1/panes/p/input",a.token,"POST",{requestId:randomUUID(),leaseId:lease.leaseId,identityToken:"identity-1",text:"still controlled"});expect(response.status).toBe(200);expect(f.backend.submitted).toBe(1);
});

test("CLI initializes an independent private state and cleans its lock after failed bind",async()=>{
  const dir=directory(),occupied=fixture();
  async function cli(args:string[]){const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),...args,"--state",dir],{stdout:"pipe",stderr:"pipe"});const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,status};}
  const init=await cli(["init","--url",`https://localhost:${occupied.bridge.server.port}`,"--listen","127.0.0.1","--port",String(occupied.bridge.server.port),"--herdr","/nonexistent-fixture-herdr"]);expect(init.status).toBe(0);
  const invite=await cli(["pair","--scope","control","--json"]);expect(invite.status).toBe(0);expect(JSON.parse(invite.stdout).version).toBe(1);
  const failed=await cli(["serve"]);expect(failed.status).toBe(1);expect(failed.stderr).not.toContain(JSON.parse(invite.stdout).code);
  expect(await Bun.file(join(dir,"serve.lock")).exists()).toBe(false);expect(statSync(join(dir,"config.json")).mode&0o777).toBe(0o600);
});

test("server invalidates active terminal identities even if a client never refreshes snapshots",async()=>{
  const f=fixture(),a=f.device(),s=await socket(f.base,a.token);const lease=await f.lease(a.token);
  s.ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",leaseId:lease.leaseId,cols:80,rows:24}));
  await eventually(()=>s.messages.some(m=>m.type==="pane_frame"));f.backend.identityToken="replacement-process";
  await eventually(()=>s.messages.some(m=>m.type==="stream_closed"&&m.reason==="identity_changed"),3500);expect(f.bridge.controls.leases.size).toBe(0);
});

test("revocation while acquisition checks identity cannot start a controller",async()=>{
  const f=fixture(),a=f.device();let release!:()=>void,entered=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.backend.identity=async(_session,paneId)=>{entered=true;await gate;return {paneId,identityToken:"identity-1",revision:1};};
  const pending=f.request("/v1/panes/p/control",a.token,"POST",{identityToken:"identity-1",takeover:true});
  await eventually(()=>entered);f.bridge.revoke(a.deviceId);release();expect((await pending).status).toBe(401);expect(f.backend.controllers).toBe(0);
});

test("only file previews permit the separately bounded eight MiB response budget",async()=>{
  const f=fixture(),a=f.device("read");f.backend.file=async()=>({content:"x".repeat(3*1024*1024)});
  expect((await f.request("/v1/workspaces/w/file?path=large.png",a.token)).status).toBe(200);
  f.backend.file=async()=>({content:"x".repeat(8*1024*1024)});
  expect((await f.request("/v1/workspaces/w/file?path=too-large.png",a.token)).status).toBe(413);
  f.backend.output=async()=>({paneId:"p",text:"x".repeat(2*1024*1024),truncated:false,revision:1,identityToken:"identity-1"});
  expect((await f.request("/v1/panes/p/output",a.token)).status).toBe(413);
});

// Keyboard events need a budget suited to interactive typing, while pairing
// and unauthenticated clients retain their separate strict limits.
test("keyboard bursts fit the authenticated device budget",async()=>{
 const f=fixture(),device=f.device(),lease=await f.lease(device.token);
 for(let index=0;index<150;index++){
  const response=await f.request("/v1/panes/p/input",device.token,"POST",{requestId:randomUUID(),leaseId:lease.leaseId,identityToken:"identity-1",bytes:"YQ=="});
  expect(response.status).toBe(200);
 }
 expect(f.backend.commands).toHaveLength(150);
});

describe("response cost",()=>{
  test("large JSON is gzipped for clients that accept it, small or unaccepted bodies are not",async()=>{
    const f=fixture(),d=f.device("control");
    f.backend.output=async()=>({paneId:"p",text:"the agent reads files and runs tests\n".repeat(400),truncated:false,revision:1,identityToken:f.backend.identityToken});
    const headers={Authorization:`Bearer ${d.token}`};
    const zipped=await fetch(`${f.base}/v1/panes/p/output`,{headers:{...headers,"Accept-Encoding":"gzip"},decompress:false});
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    const raw=new Uint8Array(await zipped.arrayBuffer());
    expect(raw.length).toBeLessThan(2000);
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw))).text).toContain("runs tests");
    const plain=await fetch(`${f.base}/v1/panes/p/output`,{headers:{...headers,"Accept-Encoding":"identity"},decompress:false});
    expect(plain.headers.get("content-encoding")).toBeNull();expect((await plain.json() as any).text).toContain("runs tests");
    const small=await fetch(`${f.base}/v1/snapshot`,{headers:{...headers,"Accept-Encoding":"gzip"},decompress:false});
    expect(small.headers.get("content-encoding")).toBeNull();expect(small.status).toBe(200);
  });
  test("phones fetching right after a change share one snapshot read, and a change of their own is never served stale",async()=>{
    const f=fixture(),d=f.device("control");let reads=0;
    (f.backend as {snapshot:()=>Promise<Record<string,unknown>>}).snapshot=async()=>{reads++;await Bun.sleep(20);return {agents:[],shellPanes:[],workspaces:[],tabs:[],sessions:[],capabilities:{},read:reads};};
    const results=await Promise.all(Array.from({length:4},()=>f.request("/v1/snapshot",d.token).then(r=>r.json() as Promise<any>)));
    expect(reads).toBe(1);expect(new Set(results.map(r=>r.read))).toEqual(new Set([1]));
    const created=await f.request("/v1/workspaces",d.token,"POST",{requestId:randomUUID(),cwd:"/tmp"});expect(created.status).toBe(200);
    expect((await (await f.request("/v1/snapshot",d.token)).json() as any).read).toBe(2);
  });
});
