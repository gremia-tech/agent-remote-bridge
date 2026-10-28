import {afterEach,expect,test} from "bun:test";
import {createServer} from "node:net";
import {connect as tlsConnect} from "node:tls";
import {Duplex} from "node:stream";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync,statSync} from "node:fs";
import {tmpdir} from "node:os";import {join} from "node:path";import {createHash} from "node:crypto";
import {createRelay,connectRelay,relayProfile,relayProfileFor,relaySecrets,TUNNEL_PROTOCOL,HOST_PROTOCOL} from "../src/relay";
import {initialize,certificatePin} from "../src/config";import {State} from "../src/state";import {createBridge} from "../src/app";
import {main} from "../src/cli";
import type {HostBackend} from "../src/backend/types";
const hostToken="h".repeat(64),phoneToken="p".repeat(64),cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
function relayFixture(){const relay=createRelay({hostToken,phoneToken,port:0});cleanup.push(()=>relay.close());return {relay,base:`127.0.0.1:${relay.server.port}`};}
function profile(base:string){return relayProfile({version:1,host:{url:`ws://${base}/v1/host`,token:hostToken},phone:{mode:"gateway",gateway:{url:`wss://relay.example/v1/tunnel`,token:phoneToken}}});}
async function until(check:()=>boolean){for(let i=0;i<200&&!check();i++)await Bun.sleep(10);expect(check()).toBe(true);}
async function phone(base:string){
 const ws=new WebSocket(`ws://${base}/v1/tunnel`,{protocols:[TUNNEL_PROTOCOL],headers:{"X-AI-Remote-Gateway-Token":phoneToken}});
 ws.binaryType="arraybuffer";cleanup.push(()=>ws.close());
 await new Promise<void>((resolve,reject)=>{ws.addEventListener("open",()=>resolve(),{once:true});ws.addEventListener("error",()=>reject(new Error("Upgrade failed")),{once:true});});return ws;
}
async function echoTarget(){
 const echo=createServer(socket=>socket.on("data",data=>socket.write(data)));echo.listen(0,"127.0.0.1");await new Promise<void>(r=>echo.once("listening",r));cleanup.push(()=>{echo.close();});
 const address=echo.address();if(!address||typeof address==="string")throw new Error("No echo listener");return {host:"127.0.0.1",port:address.port};
}
test("relay keeps phone and bridge credentials separate and refuses phones while the bridge is away",async()=>{
 const {base}=relayFixture(),url=`http://${base}`;
 expect((await fetch(url+"/health")).status).toBe(200);
 expect((await fetch(url+"/v1/tunnel")).status).toBe(401);
 expect((await fetch(url+"/v1/tunnel",{headers:{"X-AI-Remote-Gateway-Token":hostToken}})).status).toBe(401);
 expect((await fetch(url+"/v1/host",{headers:{"X-AI-Remote-Host-Token":phoneToken}})).status).toBe(401);
 expect((await fetch(url+"/v1/tunnel?target=x",{headers:{"X-AI-Remote-Gateway-Token":phoneToken}})).status).toBe(404);
 expect((await fetch(url+"/v1/tunnel",{headers:{"X-AI-Remote-Gateway-Token":phoneToken,Upgrade:"websocket","Sec-WebSocket-Protocol":TUNNEL_PROTOCOL}})).status).toBe(503);
 expect((await fetch(url+"/v1/host",{headers:{"X-AI-Remote-Host-Token":hostToken,Upgrade:"websocket","Sec-WebSocket-Protocol":TUNNEL_PROTOCOL}})).status).toBe(400);
 // A stream connection must name a stream the relay is waiting on.
 expect((await fetch(url+"/v1/host",{headers:{"X-AI-Remote-Host-Token":hostToken,Upgrade:"websocket","Sec-WebSocket-Protocol":"ai-agent-remote.stream.v1","X-AI-Remote-Stream":crypto.randomUUID()}})).status).toBe(404);
});
test("phone bytes reach the bridge's local listener byte-exact through the outbound connection",async()=>{
 const {relay,base}=relayFixture(),target=await echoTarget();
 const bridge=connectRelay({profile:profile(base),target});cleanup.push(()=>bridge.close());await until(()=>relay.bridgeConnected);
 const ws=await phone(base);const bytes=crypto.getRandomValues(new Uint8Array(200_000)),result=new Uint8Array(bytes.length);let received=0;
 const done=new Promise<void>(resolve=>ws.addEventListener("message",event=>{const chunk=new Uint8Array(event.data as ArrayBuffer);result.set(chunk,received);received+=chunk.length;if(received===bytes.length)resolve();}));
 for(let offset=0;offset<bytes.length;offset+=60_000)ws.send(bytes.subarray(offset,offset+60_000));
 await done;expect(result).toEqual(bytes);
 ws.close();await until(()=>relay.connections===0);
});
test("a newer bridge connection replaces the old one",async()=>{
 const {relay,base}=relayFixture(),target=await echoTarget();
 const first=new WebSocket(`ws://${base}/v1/host`,{protocols:[HOST_PROTOCOL],headers:{"X-AI-Remote-Host-Token":hostToken}});cleanup.push(()=>first.close());
 const replaced=new Promise<number>(r=>first.addEventListener("close",event=>r(event.code)));
 await until(()=>relay.bridgeConnected);
 const bridge=connectRelay({profile:profile(base),target});cleanup.push(()=>bridge.close());
 expect(await replaced).toBe(4000);await until(()=>bridge.connected);
 const ws=await phone(base);const echoed=new Promise<number>(r=>ws.addEventListener("message",event=>r((event.data as ArrayBuffer).byteLength)));ws.send(new Uint8Array(5));expect(await echoed).toBe(5);
});
test("the bridge's own TLS certificate reaches the phone unchanged and pairing works through the relay",async()=>{
 const {relay,base}=relayFixture(),directory=mkdtempSync(join(tmpdir(),"relay-bridge-"));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
 const config=await initialize(join(directory,"host"),{url:"https://10.89.0.1:8443",listen:"127.0.0.1",port:0});
 const state=new State(join(directory,"host"));cleanup.push(()=>state.close());
 const host=createBridge({state,backend:{snapshot:async()=>({bridge:"connected",agents:[],shellPanes:[],workspaces:[],tabs:[],sessions:[],ts:Date.now()}),close(){}} as unknown as HostBackend,hostname:"127.0.0.1",port:0,tls:{cert:Bun.file(config.certificate),key:Bun.file(config.key)}});
 cleanup.push(()=>host.close());
 const bridge=connectRelay({profile:profile(base),target:{host:"127.0.0.1",port:host.server.port!}});cleanup.push(()=>bridge.close());await until(()=>relay.bridgeConnected);
 const ws=await phone(base);
 const pipe=new Duplex({read(){},write(chunk,_encoding,callback){ws.send(chunk);callback();},final(callback){ws.close();callback();}});
 ws.addEventListener("message",event=>pipe.push(Buffer.from(event.data as ArrayBuffer)));ws.addEventListener("close",()=>pipe.push(null));
 const invite=state.invite("read");
 const body=JSON.stringify({code:invite.code,name:"Relay test phone"});
 const {pin,response}=await new Promise<{pin:string;response:string}>((resolve,reject)=>{
  const socket=tlsConnect({socket:pipe,ca:readFileSync(config.certificate,"utf8"),checkServerIdentity:()=>undefined},()=>{
   const pin=createHash("sha256").update(socket.getPeerCertificate().raw).digest("hex");
   socket.write(`POST /v1/pair HTTP/1.1\r\nHost: 10.89.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
   let text="";socket.on("data",chunk=>{text+=chunk.toString();});socket.on("end",()=>resolve({pin,response:text}));
  });
  socket.once("error",reject);
 });
 expect(pin).toBe(certificatePin(config.certificate));
 expect(response.slice(0,200)).toStartWith("HTTP/1.1 201");expect(response).toContain('"token"');
});
test("profiles, relay secrets and joining stay private and well-formed",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"relay-profile-"));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
 const secrets=relaySecrets(join(directory,"relay"));expect(relaySecrets(join(directory,"relay"))).toEqual(secrets);
 expect(statSync(join(directory,"relay","relay-secrets.json")).mode&0o777).toBe(0o600);
 const made=relayProfileFor("wss://relay.example.com",secrets);
 expect(made.host.url).toBe("wss://relay.example.com/v1/host");expect(made.phone.gateway.url).toBe("wss://relay.example.com/v1/tunnel");
 expect(made.host.token).not.toBe(made.phone.gateway.token);
 for(const bad of ["https://relay.example.com","wss://relay.example.com/sub","ws://relay.example.com"])expect(()=>relayProfileFor(bad,secrets)).toThrow();
 expect(()=>relayProfile({...made,host:{...made.host,url:"ws://relay.example.com/v1/host"}})).toThrow();
 expect(()=>relayProfile({...made,extra:1})).toThrow();
 const file=join(directory,"profile.json");writeFileSync(file,JSON.stringify(made));chmodSync(file,0o644);
 const state=join(directory,"bridge");
 await expect(main(["relay","join",file,"--state",state])).rejects.toThrow("private");
 chmodSync(file,0o600);await main(["relay","join",file,"--state",state]);
 expect(statSync(join(state,"relay.json")).mode&0o777).toBe(0o600);
 await main(["relay","leave","--state",state]);
});
