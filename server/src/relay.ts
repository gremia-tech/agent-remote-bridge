// Reverse relay for a bridge behind NAT or a work firewall. The bridge dials out to the relay
// (one control WebSocket plus one WebSocket per phone stream); phones reach the relay through the
// same authenticated byte tunnel as the standalone gateway. The relay only carries the bridge's
// end-to-end TLS bytes: it never holds the bridge certificate key, the pin or a device token.
import { timingSafeEqual, createHash, randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { existsSync, lstatSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { connectionProfile, type GatewayConnection } from "./connection";
import { privateDirectory } from "./state";

export const TUNNEL_PROTOCOL="ai-agent-remote.tunnel.v1",HOST_PROTOCOL="ai-agent-remote.host.v1",STREAM_PROTOCOL="ai-agent-remote.stream.v1";
const MAX_BUFFER=1_048_576,MAX_FRAME=65_536,CHUNK=16_384,OPEN_TIMEOUT=15_000;
const TOKEN=/^[!-~]{32,512}$/,STREAM_ID=/^[0-9a-f-]{36}$/;
function equal(a:string,b:string) {return timingSafeEqual(createHash("sha256").update(a).digest(),createHash("sha256").update(b).digest());}

/** The private file a bridge needs: where to dial out, and the route its phone invitations carry. */
export interface RelayProfile {version:1;host:{url:string;token:string};phone:{mode:"gateway";gateway:GatewayConnection};}
export function relayProfile(value:unknown):RelayProfile {
  const profile=value as RelayProfile;
  if(!profile||typeof profile!=="object"||profile.version!==1||!profile.host||typeof profile.host!=="object"||Object.keys(profile).some(k=>!["version","host","phone"].includes(k)))throw new Error("Invalid relay profile");
  if(Object.keys(profile.host).some(k=>!["url","token"].includes(k))||typeof profile.host.url!=="string"||typeof profile.host.token!=="string"||!TOKEN.test(profile.host.token))throw new Error("Invalid relay host credentials");
  const url=new URL(profile.host.url),loopback=["127.0.0.1","localhost","[::1]"].includes(url.hostname);
  if(!(url.protocol==="wss:"||url.protocol==="ws:"&&loopback)||url.username||url.password||url.pathname!=="/v1/host"||url.search||url.hash)throw new Error("Relay host endpoint must be a root WSS /v1/host URL");
  // The phone half is an ordinary gateway route; the target only matters for WireGuard routes.
  if(connectionProfile(profile.phone,"https://127.0.0.1").mode!=="gateway")throw new Error("Relay phone route must be a gateway");
  return profile;
}
export function readRelayProfile(path:string) {
  const file=lstatSync(path);
  if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0||file.size>8192)throw new Error("Relay profile must be a private regular file (chmod 600)");
  return relayProfile(JSON.parse(readFileSync(path,"utf8")));
}

/** Relay-side secrets live in their own private state directory, created on first use. */
export function relaySecrets(directory:string):{hostToken:string;phoneToken:string} {
  privateDirectory(directory);const path=join(directory,"relay-secrets.json");
  if(existsSync(path)) {
    const file=lstatSync(path);if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0)throw new Error("Relay secrets must be a private regular file");
    const value=JSON.parse(readFileSync(path,"utf8"));if(!TOKEN.test(value.hostToken)||!TOKEN.test(value.phoneToken)||value.hostToken===value.phoneToken)throw new Error("Invalid relay secrets");
    return {hostToken:value.hostToken,phoneToken:value.phoneToken};
  }
  const secrets={hostToken:randomBytes(32).toString("base64url"),phoneToken:randomBytes(32).toString("base64url")};
  writeFileSync(path,JSON.stringify(secrets)+"\n",{mode:0o600,flag:"wx"});chmodSync(path,0o600);return secrets;
}
export function relayProfileFor(publicURL:string,secrets:{hostToken:string;phoneToken:string}):RelayProfile {
  const base=new URL(publicURL);
  if(base.protocol!=="wss:"||base.username||base.password||base.search||base.hash||!["","/"].includes(base.pathname))throw new Error("--public-url must be a root wss:// URL");
  return relayProfile({version:1,host:{url:new URL("/v1/host",base).href,token:secrets.hostToken},phone:{mode:"gateway",gateway:{url:new URL("/v1/tunnel",base).href,token:secrets.phoneToken}}});
}

type Peer={kind:"phone";stream?:Stream}|{kind:"control"}|{kind:"stream";id:string;stream?:Stream};
interface Stream {id:string;phone:ServerWebSocket<Peer>;host?:ServerWebSocket<Peer>;pending:Uint8Array[];pendingBytes:number;closed:boolean;timer?:ReturnType<typeof setTimeout>;}
export interface RelayOptions {hostToken:string;phoneToken:string;hostname?:string;port?:number;maximumConnections?:number;}
export function createRelay(options:RelayOptions) {
  if(!TOKEN.test(options.hostToken)||!TOKEN.test(options.phoneToken)||options.hostToken===options.phoneToken)throw new Error("Invalid relay configuration");
  const maximum=options.maximumConnections??32;if(!Number.isInteger(maximum)||maximum<1||maximum>256)throw new Error("Invalid connection bound");
  const streams=new Map<string,Stream>(),attempts=new Map<string,{at:number;count:number}>();
  let control:ServerWebSocket<Peer>|undefined,closing=false;
  function end(stream:Stream) {
    if(stream.closed)return;stream.closed=true;clearTimeout(stream.timer);streams.delete(stream.id);stream.pending=[];
    stream.phone.close(1001,"Tunnel closed");stream.host?.close(1001,"Tunnel closed");
  }
  function send(ws:ServerWebSocket<Peer>,data:Uint8Array) {
    // Never let terminal traffic turn the relay into an unbounded buffer.
    for(let offset=0;offset<data.length;offset+=CHUNK)if(ws.getBufferedAmount()>MAX_BUFFER||ws.send(data.subarray(offset,offset+CHUNK))===-1)return false;
    return true;
  }
  function reply(status:number) {return new Response(status===200?"ok\n":"Unavailable\n",{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});}
  function rejected(ip:string) {
    const now=Date.now();let attempt=attempts.get(ip);
    if(!attempt||now-attempt.at>60_000) {
      if(attempts.size>=4096) {for(const [key,value] of attempts)if(now-value.at>60_000)attempts.delete(key);if(attempts.size>=4096&&!attempt)return reply(429);}
      attempt={at:now,count:0};attempts.set(ip,attempt);
    }
    return reply(++attempt.count>60?429:401);
  }
  const server=Bun.serve<Peer>({hostname:options.hostname??"127.0.0.1",port:options.port??8788,
    fetch(request,server) {
      const url=new URL(request.url);
      if(url.pathname==="/health"&&request.method==="GET"&&!url.search)return reply(200);
      if(closing||!["/v1/tunnel","/v1/host"].includes(url.pathname)||url.search||request.method!=="GET")return reply(404);
      const phone=url.pathname==="/v1/tunnel",ip=server.requestIP(request)?.address??"unknown";
      const token=request.headers.get(phone?"X-AI-Remote-Gateway-Token":"X-AI-Remote-Host-Token")??"";
      if(!equal(token,phone?options.phoneToken:options.hostToken))return rejected(ip);
      // Authenticated clients never inherit the shared proxy IP's rejection budget.
      const protocol=request.headers.get("sec-websocket-protocol")??"",id=request.headers.get("X-AI-Remote-Stream");
      if(request.headers.get("upgrade")?.toLowerCase()!=="websocket")return reply(400);
      let data:Peer;
      if(phone) {
        if(protocol!==TUNNEL_PROTOCOL)return reply(400);
        if(!control||streams.size>=maximum)return reply(503);
        data={kind:"phone"};
      } else if(protocol===HOST_PROTOCOL&&id===null)data={kind:"control"};
      else if(protocol===STREAM_PROTOCOL&&id!==null&&STREAM_ID.test(id)) {
        const stream=streams.get(id);if(!stream||stream.host)return reply(404);
        data={kind:"stream",id};
      } else return reply(400);
      if(server.upgrade(request,{data,headers:{"Sec-WebSocket-Protocol":protocol}}))return;
      return reply(400);
    },
    websocket:{maxPayloadLength:MAX_FRAME,backpressureLimit:MAX_BUFFER,closeOnBackpressureLimit:true,idleTimeout:120,perMessageDeflate:false,
      open(ws) {
        const peer=ws.data;
        if(closing){ws.close(1001,"Relay closing");return;}
        if(peer.kind==="control") {
          // The newest bridge connection wins, so a dropped network never strands the relay on a dead socket.
          const previous=control;control=ws;previous?.close(4000,"Replaced by a newer bridge connection");
          for(const stream of streams.values())if(!stream.host)end(stream);
          return;
        }
        if(peer.kind==="phone") {
          if(!control){ws.close(1013,"Bridge offline");return;}
          const stream:Stream={id:randomUUID(),phone:ws,pending:[],pendingBytes:0,closed:false};peer.stream=stream;streams.set(stream.id,stream);
          stream.timer=setTimeout(()=>end(stream),OPEN_TIMEOUT);
          control.send(JSON.stringify({type:"open",id:stream.id}));
          return;
        }
        const stream=streams.get(peer.id);
        if(!stream||stream.host||stream.closed){ws.close(1008,"Unknown stream");return;}
        stream.host=ws;peer.stream=stream;clearTimeout(stream.timer);
        for(const chunk of stream.pending.splice(0))if(!send(ws,chunk)){end(stream);return;}
        stream.pendingBytes=0;
      },
      message(ws,message) {
        const peer=ws.data;
        if(peer.kind==="control"){if(message==='{"type":"ping"}')ws.send('{"type":"pong"}');return;}
        const stream=peer.stream;if(!stream||stream.closed)return;
        if(typeof message==="string"||message.length>MAX_FRAME){end(stream);return;}
        if(peer.kind==="phone"&&!stream.host) {
          if(stream.pendingBytes+message.length>MAX_BUFFER){end(stream);return;}
          stream.pending.push(new Uint8Array(message));stream.pendingBytes+=message.length;return;
        }
        if(!send(peer.kind==="phone"?stream.host!:stream.phone,message))end(stream);
      },
      close(ws) {
        const peer=ws.data;
        if(peer.kind==="control"){if(control===ws){control=undefined;for(const stream of streams.values())if(!stream.host)end(stream);}return;}
        if(peer.stream)end(peer.stream);
      },
      drain(ws){const peer=ws.data;if(peer.kind!=="control"&&peer.stream&&ws.getBufferedAmount()>MAX_BUFFER)end(peer.stream);}
    }
  });
  return {server,close(){if(closing)return;closing=true;for(const stream of [...streams.values()])end(stream);control?.close(1001,"Relay closing");server.stop(true);},
    get connections(){return streams.size;},get bridgeConnected(){return !!control;}};
}

/** Bridge side: keep an outbound control connection open and splice each phone stream into the local listener. */
export function connectRelay(options:{profile:RelayProfile;target:{host:string;port:number};log?:(event:Record<string,unknown>)=>void;proxy?:string}) {
  const {url,token}=options.profile.host,log=options.log??(()=>{});
  const proxy=options.proxy??process.env.HTTPS_PROXY??process.env.https_proxy;
  const base={headers:{"X-AI-Remote-Host-Token":token},...(proxy?{proxy}:{})};
  let closed=false,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,delay=1000;
  const live=new Set<{ws:WebSocket;local?:Socket}>();
  function stream(id:string) {
    if(!STREAM_ID.test(id)||live.size>=64)return;
    const ws=new WebSocket(url,{...base,headers:{...base.headers,"X-AI-Remote-Stream":id},protocols:[STREAM_PROTOCOL]});
    ws.binaryType="arraybuffer";const entry:{ws:WebSocket;local?:Socket}={ws};live.add(entry);
    let paused:ReturnType<typeof setInterval>|undefined;
    const finish=()=>{if(!live.delete(entry))return;clearInterval(paused);entry.local?.destroy();try{ws.close();}catch{}};
    ws.addEventListener("open",()=>{
      const local=createConnection({host:options.target.host,port:options.target.port});entry.local=local;
      local.on("data",(data:Buffer)=>{
        for(let offset=0;offset<data.length;offset+=CHUNK)ws.send(data.subarray(offset,offset+CHUNK));
        // Hold the bridge's output while the relay drains, rather than buffering without bound.
        if(ws.bufferedAmount>MAX_BUFFER&&!paused){local.pause();paused=setInterval(()=>{if(ws.bufferedAmount<MAX_BUFFER/4){clearInterval(paused);paused=undefined;local.resume();}},20);}
      });
      local.on("error",finish);local.on("close",finish);
    });
    ws.addEventListener("message",event=>{
      if(typeof event.data==="string"){finish();return;}
      const local=entry.local;if(!local||local.destroyed||local.writableLength>MAX_BUFFER){finish();return;}
      local.write(new Uint8Array(event.data as ArrayBuffer));
    });
    ws.addEventListener("close",finish);ws.addEventListener("error",finish);
  }
  function connect() {
    if(closed)return;
    const ws=new WebSocket(url,{...base,protocols:[HOST_PROTOCOL]});socket=ws;
    let seen=Date.now(),opened=false;
    ws.addEventListener("open",()=>{opened=true;delay=1000;seen=Date.now();log({event:"relay_connected",url:new URL(url).host});
      // Proxies such as Cloudflare drop quiet WebSockets; a missing pong means the path is dead.
      heartbeat=setInterval(()=>{if(Date.now()-seen>90_000){ws.close();return;}try{ws.send('{"type":"ping"}');}catch{}},30_000);
    });
    ws.addEventListener("message",event=>{
      seen=Date.now();if(typeof event.data!=="string")return;
      try{const message=JSON.parse(event.data) as {type?:string;id?:string};if(message.type==="open"&&typeof message.id==="string")stream(message.id);}catch{}
    });
    ws.addEventListener("close",event=>{
      clearInterval(heartbeat);if(socket===ws)socket=undefined;if(closed)return;
      log({event:"relay_disconnected",code:event.code,retryInSeconds:delay/1000,...(opened?{}:{reason:"could not connect"})});
      retry=setTimeout(connect,delay);delay=Math.min(delay*2,30_000);
    });
    ws.addEventListener("error",()=>{});
  }
  connect();
  return {close(){closed=true;clearTimeout(retry);clearInterval(heartbeat);socket?.close();for(const entry of [...live]){entry.local?.destroy();entry.ws.close();}live.clear();},
    get connected(){return socket?.readyState===WebSocket.OPEN;}};
}
