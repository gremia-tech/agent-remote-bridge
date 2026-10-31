import {afterEach,expect,test} from "bun:test";
import {connect as tlsConnect} from "node:tls";
import {Duplex} from "node:stream";
import {mkdtempSync,rmSync,readFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";import {join} from "node:path";import {createHash,verify,X509Certificate} from "node:crypto";
import {createRelay,connectRelay,relayProfile,TUNNEL_PROTOCOL} from "../src/relay";
import {initialize,certificatePin,loadConfig} from "../src/config";import {State} from "../src/state";import {createBridge} from "../src/app";
import {renewCertificate,switchCertificate,certificateStatus,maintainCertificate} from "../src/certificate";
import {startConsole,consoleLaunchURL} from "../src/console";
import type {HostBackend} from "../src/backend/types";
const hostToken="h".repeat(64),phoneToken="p".repeat(64),cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
async function until(check:()=>boolean){for(let i=0;i<300&&!check();i++)await Bun.sleep(10);expect(check()).toBe(true);}
const backend={snapshot:async()=>({bridge:"connected",agents:[],shellPanes:[],workspaces:[],tabs:[],sessions:[],ts:Date.now()}),close(){}} as unknown as HostBackend;
function temp(){const d=mkdtempSync(join(tmpdir(),"hmr-security-"));cleanup.push(()=>rmSync(d,{recursive:true,force:true}));return d;}
async function tunnel(base:string,token:string){
 const ws=new WebSocket(`ws://${base}/v1/tunnel`,{protocols:[TUNNEL_PROTOCOL],headers:{"X-AI-Remote-Gateway-Token":token}});ws.binaryType="arraybuffer";cleanup.push(()=>ws.close());
 await new Promise<void>((resolve,reject)=>{ws.addEventListener("open",()=>resolve(),{once:true});ws.addEventListener("error",()=>reject(new Error("refused")),{once:true});});return ws;
}
/** One HTTPS request through a relay tunnel, as the phone makes it (TLS ends at the bridge). */
async function request(ws:WebSocket,certificate:string,method:string,path:string,body?:unknown){
 const pipe=new Duplex({read(){},write(chunk,_e,callback){ws.send(chunk);callback();},final(callback){callback();}});
 ws.addEventListener("message",event=>pipe.push(Buffer.from(event.data as ArrayBuffer)));ws.addEventListener("close",()=>pipe.push(null));
 const text=body===undefined?"":JSON.stringify(body);
 return new Promise<string>((resolve,reject)=>{
  const socket=tlsConnect({socket:pipe,ca:readFileSync(certificate,"utf8"),checkServerIdentity:()=>undefined},()=>{
   socket.write(`${method} ${path} HTTP/1.1\r\nHost: 10.89.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
   let out="";socket.on("data",chunk=>{out+=chunk.toString();});socket.on("end",()=>resolve(out));
  });socket.once("error",reject);
 });
}
async function relayedBridge(sharedPhoneToken=true){
 const relay=createRelay({hostToken,phoneToken,port:0,sharedPhoneToken});cleanup.push(()=>relay.close());const base=`127.0.0.1:${relay.server.port}`;
 const directory=temp(),config=await initialize(join(directory,"host"),{url:"https://10.89.0.1:8443",listen:"127.0.0.1",port:0});
 const state=new State(join(directory,"host"));cleanup.push(()=>state.close());
 let supported=false;const announced:string[]=[];
 const host=createBridge({state,backend,hostname:"127.0.0.1",port:0,tls:{cert:Bun.file(config.certificate),key:Bun.file(config.key)},
  nearby:{scope:"control",announce:r=>announced.push(r.code)},relay:{gateway:{url:"wss://relay.example/v1/tunnel",token:phoneToken},credentials:()=>supported}});
 cleanup.push(()=>host.close());
 const profile=relayProfile({version:1,host:{url:`ws://${base}/v1/host`,token:hostToken},phone:{mode:"gateway",gateway:{url:"wss://relay.example/v1/tunnel",token:phoneToken}}});
 const bridge=connectRelay({profile,target:{host:"127.0.0.1",port:host.relayServer!.port!},credentials:()=>state.relayDigests(),onHello:revision=>{supported=revision>=2;}});
 cleanup.push(()=>bridge.close());await until(()=>relay.bridgeConnected&&supported);
 return {relay,base,config,state,host,bridge,announced};
}
test("nearby pairing is refused for relayed connections but still works on this network",async()=>{
 const {base,config,host,announced}=await relayedBridge();
 const through=await request(await tunnel(base,phoneToken),config.certificate,"POST","/v1/pair/nearby",{name:"Stranger"});
 expect(through.slice(0,12)).toBe("HTTP/1.1 403");expect(announced).toEqual([]);
 // The same bridge's own listener, reached from this machine, is the local network.
 const local=await fetch(`https://127.0.0.1:${host.server.port}/v1/pair/nearby`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Laptop"}),tls:{rejectUnauthorized:false}} as RequestInit);
 expect(local.status).toBe(201);expect(announced.length).toBe(1);
});
test("per-device relay credentials: invitations mint one, pairing binds it, revocation removes it at the relay",async()=>{
 const {relay,base,config,state}=await relayedBridge(false);
 // The shared token no longer opens the relay once it admits only listed devices.
 await expect(tunnel(base,phoneToken)).rejects.toThrow();
 const invite=state.invite("control",300,true);expect(invite.relayToken).toBeString();
 await until(()=>state.relayDigests().includes(createHash("sha256").update(invite.relayToken!).digest("hex")));
 await Bun.sleep(2200);// the connector re-reads the list every two seconds
 const paired=await request(await tunnel(base,invite.relayToken!),config.certificate,"POST","/v1/pair",{code:invite.code,name:"Phone"});
 expect(paired.slice(0,12)).toBe("HTTP/1.1 201");
 const device=state.devices()[0]!;
 // A live stream with the credential is cut as soon as the device is revoked.
 const live=await tunnel(base,invite.relayToken!);const closed=new Promise<void>(r=>live.addEventListener("close",()=>r()));
 state.revoke(device.id);expect(state.relayDigests()).toEqual([]);
 await closed;await expect(tunnel(base,invite.relayToken!)).rejects.toThrow();
 expect(relay.connections).toBe(0);
});
test("a paired device can swap the shared relay token for its own",async()=>{
 const {base,config,state}=await relayedBridge();
 const invite=state.invite("read");
 const pair=await request(await tunnel(base,phoneToken),config.certificate,"POST","/v1/pair",{code:invite.code,name:"Old phone"});
 const token=JSON.parse(pair.slice(pair.indexOf("\r\n\r\n")+4)).token as string;
 const ws=await tunnel(base,phoneToken),pipeResponse=await requestWithToken(ws,config.certificate,token);
 expect(pipeResponse.slice(0,12)).toBe("HTTP/1.1 201");
 const credential=JSON.parse(pipeResponse.slice(pipeResponse.indexOf("\r\n\r\n")+4)) as {url:string;token:string};
 expect(credential.url).toBe("wss://relay.example/v1/tunnel");
 expect(state.relayDigests()).toEqual([createHash("sha256").update(credential.token).digest("hex")]);
});
async function requestWithToken(ws:WebSocket,certificate:string,token:string){
 const pipe=new Duplex({read(){},write(chunk,_e,callback){ws.send(chunk);callback();},final(callback){callback();}});
 ws.addEventListener("message",event=>pipe.push(Buffer.from(event.data as ArrayBuffer)));ws.addEventListener("close",()=>pipe.push(null));
 return new Promise<string>((resolve,reject)=>{
  const socket=tlsConnect({socket:pipe,ca:readFileSync(certificate,"utf8"),checkServerIdentity:()=>undefined},()=>{
   socket.write(`POST /v1/relay/credential HTTP/1.1\r\nHost: 10.89.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
   let out="";socket.on("data",chunk=>{out+=chunk.toString();});socket.on("end",()=>resolve(out));
  });socket.once("error",reject);
 });
}
test("relay stats and the replaced-connection warning reach the bridge",async()=>{
 const relay=createRelay({hostToken,phoneToken,port:0,statsMilliseconds:50});cleanup.push(()=>relay.close());const base=`127.0.0.1:${relay.server.port}`;
 const events:Record<string,unknown>[]=[];
 const profile=relayProfile({version:1,host:{url:`ws://${base}/v1/host`,token:hostToken},phone:{mode:"gateway",gateway:{url:"wss://relay.example/v1/tunnel",token:phoneToken}}});
 const bridge=connectRelay({profile,target:{host:"127.0.0.1",port:1},log:e=>events.push(e)});cleanup.push(()=>bridge.close());
 await until(()=>bridge.status.revision===2);
 await fetch(`http://${base}/v1/tunnel`,{headers:{"X-AI-Remote-Gateway-Token":"x".repeat(40)}});
 await until(()=>bridge.status.rejected===1);
 const second=connectRelay({profile,target:{host:"127.0.0.1",port:1}});cleanup.push(()=>second.close());
 await until(()=>events.some(e=>e.event==="relay_replaced"));
});
test("invitation relay credentials expire with the invitation and stay bound after pairing",()=>{
 const state=new State(temp());cleanup.push(()=>state.close());
 const kept=state.invite("read",300,true),dropped=state.invite("read",1,true);
 expect(state.relayDigests().length).toBe(2);
 state.pair(kept.code,"Phone");
 const db=state.db;db.query("UPDATE relay_credentials SET expires=0 WHERE device IS NULL").run();
 expect(state.relayDigests()).toEqual([createHash("sha256").update(kept.relayToken!).digest("hex")]);
 expect(dropped.relayToken).not.toBe(kept.relayToken);
});
test("certificate renewal: the old key signs the successor's pin and switching keeps the same names",async()=>{
 const directory=join(temp(),"host"),config=await initialize(directory,{url:"https://10.89.0.1:8443",listen:"127.0.0.1",port:8443,sans:["laptop.local"]});
 const state=new State(directory);cleanup.push(()=>state.close());
 const old=certificatePin(config.certificate),status=await renewCertificate(config,state.hostId,new Date(Date.now()+86_400_000));
 const next=status.next!;expect(next.pin).not.toBe(old);
 const statement=JSON.parse(next.statement);expect(statement).toMatchObject({version:1,hostId:state.hostId,previous:old,next:next.pin});
 const previous=new X509Certificate(Buffer.from(next.previousCertificate,"base64"));
 expect(createHash("sha256").update(previous.raw).digest("hex")).toBe(old);
 expect(verify("sha256",Buffer.from(next.statement),previous.publicKey,Buffer.from(next.signature,"base64"))).toBe(true);
 expect(await maintainCertificate(config,state.hostId)).toBe(false);// not due yet
 expect(switchCertificate(loadConfig(directory))).toBe(true);
 expect(certificatePin(config.certificate)).toBe(next.pin);
 const renewed=new X509Certificate(readFileSync(config.certificate));expect(renewed.subjectAltName).toContain("10.89.0.1");expect(renewed.subjectAltName).toContain("laptop.local");
 expect(certificateStatus(loadConfig(directory),state.hostId).next).toBeUndefined();
});
test("console: one-time launch, loopback Host only, CSRF on writes, no secrets in responses",async()=>{
 const directory=join(temp(),"host"),config=await initialize(directory,{url:"https://10.89.0.1:8443",listen:"127.0.0.1",port:8443});
 const state=new State(directory);cleanup.push(()=>state.close());
 const host=createBridge({state,backend,hostname:"127.0.0.1",port:0,tls:{cert:Bun.file(config.certificate),key:Bun.file(config.key)}});cleanup.push(()=>host.close());
 const services={state,config,bridge:host,backend:"herdr",discoverable:false,localRoute:false,localRoutes:()=>[],listen:"127.0.0.1",port:host.server.port!,startedAt:new Date().toISOString(),close(){}} as never;
 let restarts=0;
 const panel=startConsole({directory,port:18790,services:()=>services,restart:async()=>{restarts++;},version:"test"});cleanup.push(()=>panel.close());
 const origin=`http://127.0.0.1:${panel.port}`,launch=new URL(consoleLaunchURL(directory)).hash.slice("#launch=".length);
 expect((await fetch(origin+"/",{headers:{Host:"evil.example:"+panel.port}})).status).toBe(403);
 expect((await fetch(origin+"/api/status")).status).toBe(401);
 const open=(secret:string)=>fetch(origin+"/api/session",{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify({launch:secret})});
 const first=await open(launch);expect(first.status).toBe(201);
 const cookie=first.headers.get("set-cookie")!.split(";")[0]!,{csrf}=await first.json() as {csrf:string};
 expect(first.headers.get("set-cookie")).toContain("HttpOnly");expect(first.headers.get("set-cookie")).toContain("SameSite=Strict");
 expect((await open(launch)).status).toBe(401);// single use
 expect(existsSync(join(directory,"console-launch.json"))).toBe(false);
 const status=await (await fetch(origin+"/api/status",{headers:{Cookie:cookie}})).text();
 expect(status).toContain('"running":true');expect(status).not.toContain("BEGIN");
 // Writes need the page's own origin and its CSRF token.
 const put=(headers:Record<string,string>)=>fetch(origin+"/api/config",{method:"PUT",headers:{"Content-Type":"application/json",Cookie:cookie,...headers},body:JSON.stringify({hostName:"Studio"})});
 expect((await put({Origin:origin})).status).toBe(403);
 expect((await put({Origin:"http://evil.example","X-Console-CSRF":csrf})).status).toBe(403);
 expect((await put({Origin:origin,"X-Console-CSRF":csrf})).status).toBe(200);
 expect(loadConfig(directory).hostName).toBe("Studio");
 const bad=await fetch(origin+"/api/config",{method:"PUT",headers:{"Content-Type":"application/json",Cookie:cookie,Origin:origin,"X-Console-CSRF":csrf},body:JSON.stringify({certificate:"/tmp/x"})});
 expect(bad.status).toBe(400);
 const qr=await (await fetch(origin+"/api/pair",{method:"POST",headers:{"Content-Type":"application/json",Cookie:cookie,Origin:origin,"X-Console-CSRF":csrf},body:JSON.stringify({scope:"read",ttl:300})})).json() as {svg:string};
 expect(qr.svg).toStartWith("<svg");
 const restart=await fetch(origin+"/api/restart",{method:"POST",headers:{"Content-Type":"application/json",Cookie:cookie,Origin:origin,"X-Console-CSRF":csrf},body:"{}"});
 expect(restart.status).toBe(200);expect(restarts).toBe(1);
});
test("owner-made invitations can last longer and pair a few devices, then stop",()=>{
 const state=new State(temp());cleanup.push(()=>state.close());
 expect(()=>state.invite("read",2_592_001)).toThrow();expect(()=>state.invite("read",300,false,21)).toThrow();
 const invite=state.invite("control",14*86_400,false,2);
 state.pair(invite.code,"Reviewer 1");state.pair(invite.code,"Reviewer 2");
 expect(()=>state.pair(invite.code,"Reviewer 3")).toThrow();
 expect(state.devices().map(d=>d.scope)).toEqual(["control","control"]);
});
test("plain ws to a relay is limited to this machine or a container name",()=>{
 const make=(url:string)=>relayProfile({version:1,host:{url,token:hostToken},phone:{mode:"gateway",gateway:{url:"wss://relay.example/v1/tunnel",token:phoneToken}}});
 expect(make("ws://relay:8788/v1/host").host.url).toBe("ws://relay:8788/v1/host");
 expect(()=>make("ws://relay.example.com:8788/v1/host")).toThrow();
 expect(()=>make("ws://10.0.0.5:8788/v1/host")).toThrow();
});
