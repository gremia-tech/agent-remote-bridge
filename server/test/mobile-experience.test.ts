import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state";
import { createBridge } from "../src/app";
import type { HostBackend, TerminalHandle } from "../src/backend/types";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function directory(){const d=mkdtempSync(join(tmpdir(),"herdr-mobile-"));cleanup.push(()=>rmSync(d,{recursive:true,force:true}));return d;}
/** A pane whose computer-side grid is 132x41; the phone must not crop or reflow it by default. */
class SizedBackend implements HostBackend {
  identityToken="identity-1";size={cols:132,rows:41};status="idle";opened:{control:boolean,cols:number,rows:number}[]=[];commands:any[]=[];
  async snapshot(){return {agents:[],shellPanes:[{paneId:"p",status:this.status,revision:Math.random()}],workspaces:[],tabs:[],sessions:[],capabilities:{terminal:true},ts:Date.now()};}
  async identity(_s:string|undefined,paneId:string){return {paneId,identityToken:this.identityToken,revision:1};}
  async paneSize(){return {...this.size};}
  async output(){return {};}async transcript(){return {};}async git(){return {};}async diff(){return {};}async files(){return {};}async file(){return {};}
  async terminal(o:Parameters<HostBackend["terminal"]>[0]):Promise<TerminalHandle>{this.opened.push({control:o.control,cols:o.cols,rows:o.rows});let open=true;
    queueMicrotask(()=>{if(open)o.onFrame({type:"pane_frame",paneId:o.paneId,identityToken:this.identityToken,seq:1,full:true,width:o.cols,height:o.rows,bytes:Buffer.from("x").toString("base64")});});
    return {command:async v=>{this.commands.push(v);},close:()=>{if(open){open=false;o.onClose("released");}}};
  }
  async submitText(){return {};}async mutate(){return {};}close(){}
}
function fixture(nearby=false){
  const state=new State(directory(),true),backend=new SizedBackend(),announced:{name:string,code:string}[]=[];
  const bridge=createBridge({state,backend,hostName:"studio",...(nearby?{nearby:{scope:"control" as const,announce:(r:{name:string,code:string})=>announced.push(r)}}:{})});
  cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
  const base=bridge.server.url.origin;
  const device=()=>state.pair(state.invite("control").code,"Phone");
  const request=(path:string,token?:string,method="GET",value?:unknown)=>fetch(`${base}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}),...(value!==undefined?{"Content-Type":"application/json"}:{})},body:value===undefined?undefined:JSON.stringify(value)});
  return {state,backend,bridge,base,device,request,announced};
}
async function eventually(check:()=>boolean,timeout=3000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error("Timed out");await Bun.sleep(10);}}
async function socket(base:string,token:string){const ws=new WebSocket(base.replace(/^http/,"ws")+"/v1/live",{headers:{Authorization:`Bearer ${token}`}});const messages:any[]=[];ws.addEventListener("message",e=>messages.push(JSON.parse(e.data as string)));await new Promise<void>((resolve,reject)=>{ws.addEventListener("open",()=>resolve(),{once:true});ws.addEventListener("error",()=>reject(new Error("WebSocket failed")),{once:true});});cleanup.push(()=>ws.close());return {ws,messages};}

test("host-fit observation streams the computer's exact grid and follows pane resizes",async()=>{
  const f=fixture(),d=f.device(),{ws,messages}=await socket(f.base,d.token);
  ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",fit:"host"}));
  await eventually(()=>messages.some(m=>m.type==="pane_frame"));
  expect(messages.find(m=>m.type==="pane_frame")).toMatchObject({width:132,height:41,full:true});
  f.backend.size={cols:100,rows:30};
  // The host asks the client to resubscribe; the new stream starts at the new size.
  await eventually(()=>messages.some(m=>m.type==="stream_closed" && m.reason==="resync_required"),5000);
  ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",fit:"host"}));
  await eventually(()=>messages.some(m=>m.type==="pane_frame" && m.width===100 && m.height===30),5000);
  expect(f.backend.opened.every(o=>!o.control)).toBe(true);
});

test("control attaches at the computer's size, phone fit is explicit and the size is restored on release",async()=>{
  const f=fixture(),d=f.device(),{ws,messages}=await socket(f.base,d.token);
  ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",fit:"host"}));
  await eventually(()=>messages.some(m=>m.type==="pane_frame"));
  const lease=await (await f.request("/v1/panes/p/control",d.token,"POST",{identityToken:"identity-1"})).json() as {leaseId:string};
  expect(f.backend.opened.find(o=>o.control)).toEqual({control:true,cols:132,rows:41});
  expect(f.backend.commands).toEqual([]);
  ws.send(JSON.stringify({type:"resize",leaseId:lease.leaseId,cols:48,rows:30}));
  await eventually(()=>f.backend.commands.some(c=>c.type==="terminal.resize"));
  ws.send(JSON.stringify({type:"resize",leaseId:lease.leaseId,cols:48,rows:30}));
  await Bun.sleep(100);expect(f.backend.commands.filter(c=>c.type==="terminal.resize")).toHaveLength(1);
  f.backend.size={cols:48,rows:30};
  expect((await f.request(`/v1/control/${lease.leaseId}`,d.token,"DELETE")).status).toBe(200);
  // Still viewing on this phone: the pane keeps the phone size after release.
  await Bun.sleep(300);
  expect(f.backend.commands.filter(c=>c.type==="terminal.resize")).toHaveLength(1);
  // The app resubscribes right after control ends, as the real client does.
  ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",fit:"host"}));
  await eventually(()=>messages.some(m=>m.type==="pane_frame" && m.width===48));
  // Re-acquiring remembers the computer's original size.
  const again=await (await f.request("/v1/panes/p/control",d.token,"POST",{identityToken:"identity-1"})).json() as {leaseId:string};
  expect(f.backend.opened.filter(o=>o.control).at(-1)).toEqual({control:true,cols:48,rows:30});
  expect((await f.request(`/v1/control/${again.leaseId}`,d.token,"DELETE")).status).toBe(200);
  ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",fit:"host"}));
  await Bun.sleep(2500);
  expect(f.backend.opened.filter(o=>o.control && o.cols===132)).toHaveLength(1); // only the first attach
  // Leaving the pane gives it back to the computer at its original size.
  const before=f.backend.opened.length;
  ws.send(JSON.stringify({type:"unobserve"}));
  await eventually(()=>f.backend.opened.slice(before).some(o=>o.control && o.cols===132 && o.rows===41),5000);
},15000);

test("live keystrokes need this socket's lease, are delivered once and never journaled",async()=>{
  const f=fixture(),d=f.device(),other=f.device(),{ws,messages}=await socket(f.base,d.token);
  ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",fit:"host"}));
  await eventually(()=>messages.some(m=>m.type==="pane_frame"));
  const lease=await (await f.request("/v1/panes/p/control",d.token,"POST",{identityToken:"identity-1"})).json() as {leaseId:string};
  await eventually(()=>messages.filter(m=>m.type==="pane_frame").length>=2);
  const bytes=Buffer.from("ls\r").toString("base64");
  ws.send(JSON.stringify({type:"input",leaseId:lease.leaseId,bytes}));
  await eventually(()=>f.backend.commands.some(c=>c.type==="terminal.input"));
  expect(f.backend.commands.find(c=>c.type==="terminal.input")).toEqual({type:"terminal.input",bytes,encoding:"base64"});
  expect((f.state.db.query("SELECT count(*) AS n FROM operations").get() as {n:number}).n).toBe(0);
  // Keys sent while the socket re-observes (e.g. right after a resize) are not dropped.
  ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",fit:"host",leaseId:lease.leaseId}));
  ws.send(JSON.stringify({type:"input",leaseId:lease.leaseId,bytes}));
  await eventually(()=>f.backend.commands.filter(c=>c.type==="terminal.input").length===2);
  // Another device cannot borrow the lease through its own socket.
  const intruder=await socket(f.base,other.token);
  intruder.ws.send(JSON.stringify({type:"input",leaseId:lease.leaseId,bytes}));
  await eventually(()=>intruder.messages.some(m=>m.type==="error"));
  expect(f.backend.commands.filter(c=>c.type==="terminal.input")).toHaveLength(2);
  ws.send(JSON.stringify({type:"input",leaseId:lease.leaseId,bytes:"not base64!"}));
  await eventually(()=>messages.some(m=>m.type==="error" && m.code==="invalid_request"));
});

test("scrolling sends one desktop-sized notch per command so mouse-driven apps move as far as scrollback",async()=>{
  const f=fixture(),d=f.device(),{ws,messages}=await socket(f.base,d.token);
  ws.send(JSON.stringify({type:"observe",paneId:"p",identityToken:"identity-1",fit:"host"}));
  await eventually(()=>messages.some(m=>m.type==="pane_frame"));
  const lease=await (await f.request("/v1/panes/p/control",d.token,"POST",{identityToken:"identity-1"})).json() as {leaseId:string};
  ws.send(JSON.stringify({type:"scroll",leaseId:lease.leaseId,direction:"up",lines:7}));
  await eventually(()=>f.backend.commands.filter(c=>c.type==="terminal.scroll").length===3);
  expect(f.backend.commands.filter(c=>c.type==="terminal.scroll")).toEqual([
    {type:"terminal.scroll",direction:"up",lines:3,column:66,row:20},
    {type:"terminal.scroll",direction:"up",lines:3,column:66,row:20},
    {type:"terminal.scroll",direction:"up",lines:1,column:66,row:20}]);
});

test("snapshot_changed is sent when state changes, not on every tick",async()=>{
  const f=fixture(),d=f.device(),{messages}=await socket(f.base,d.token);
  await Bun.sleep(2600);
  expect(messages.filter(m=>m.type==="snapshot_changed")).toHaveLength(0);
  f.backend.status="working";
  await eventually(()=>messages.some(m=>m.type==="snapshot_changed"),3000);
  const snapshot=await (await f.request("/v1/snapshot",d.token)).json() as any;
  expect(snapshot.capabilities).toMatchObject({liveInput:true,hostSizedTerminal:true});
});

test("nearby pairing requires the code shown on the computer and limits guesses",async()=>{
  const off=fixture(false);
  expect((await off.request("/v1/pair/nearby",undefined,"POST",{name:"Phone"})).status).toBe(501);
  const f=fixture(true);
  const start=await f.request("/v1/pair/nearby",undefined,"POST",{name:"Sam's iPhone"});
  expect(start.status).toBe(201);
  const {requestId}=await start.json() as {requestId:string};
  expect(f.announced).toHaveLength(1);expect(f.announced[0]!.code).toMatch(/^\d{6}$/);
  const code=f.announced[0]!.code,wrong=code==="000000"?"111111":"000000";
  const bad=await f.request("/v1/pair/nearby/confirm",undefined,"POST",{requestId,code:wrong});
  expect(bad.status).toBe(403);expect((await bad.json() as any).error.code).toBe("invalid_code");
  const ok=await f.request("/v1/pair/nearby/confirm",undefined,"POST",{requestId,code});
  expect(ok.status).toBe(201);
  const paired=await ok.json() as {token:string,scope:string,hostName:string};
  expect(paired).toMatchObject({scope:"control",hostName:"studio"});
  expect((await f.request("/v1/snapshot",paired.token)).status).toBe(200);
  expect((await f.request("/v1/pair/nearby/confirm",undefined,"POST",{requestId,code})).status).toBe(410);
  // Brute force: the request dies after five attempts even if the sixth is right.
  const second=await (await f.request("/v1/pair/nearby",undefined,"POST",{name:"Guesser"})).json() as {requestId:string};
  const secret=f.announced[1]!.code,guess=secret==="123456"?"654321":"123456";
  for(let i=0;i<5;i++)expect((await f.request("/v1/pair/nearby/confirm",undefined,"POST",{requestId:second.requestId,code:guess})).status).toBe(403);
  expect((await f.request("/v1/pair/nearby/confirm",undefined,"POST",{requestId:second.requestId,code:secret})).status).toBe(410);
});
