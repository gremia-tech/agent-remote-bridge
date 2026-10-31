import type { ServerWebSocket } from "bun";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { HostBackend, TerminalHandle, TerminalFrame } from "./backend/types";
import { Controls, deadline } from "./control";
import type { Lease } from "./control";
import { BridgeError, failure } from "./errors";
import { State, hash, canonical } from "./state";
import type { Device, Scope } from "./state";
import type { GatewayConnection } from "./connection";

const MAX_BODY=65_536, MAX_RESPONSE=2_097_152, MAX_FILE_RESPONSE=8_388_608;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function str(value:unknown,max=256,min=1):string {if(typeof value!=="string" || value.length<min || value.length>max || value.includes("\0"))throw new BridgeError("invalid_request","Invalid string");return value;}
function integer(value:unknown,min:number,max:number):number {if(typeof value!=="number" || !Number.isInteger(value) || value<min || value>max)throw new BridgeError("invalid_request","Invalid integer");return value;}
function only(body:Record<string,unknown>,keys:string[]) {if(Object.keys(body).some(key=>!keys.includes(key)))throw new BridgeError("invalid_request","Unknown field");}
function control(device:Device) {if(device.scope!=="control")throw new BridgeError("forbidden","Read only",403);}
function reply(body:unknown,status=200,maximum=MAX_RESPONSE) {
  const json=JSON.stringify(body);
  if(Buffer.byteLength(json)>maximum)throw new BridgeError("response_too_large","Response limit",413);
  return new Response(json,{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}});
}
/** Gzip JSON over 1 KB for clients that accept it. Snapshots, transcripts and terminal output are text that
 *  shrinks several times, which matters most over a VPN or the relay; phones decompress transparently. */
async function compressed(request:Request,response:Response):Promise<Response> {
  if(!/\bgzip\b/i.test(request.headers.get("accept-encoding")??"") || !response.headers.get("content-type")?.startsWith("application/json"))return response;
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length<1024)return new Response(bytes,{status:response.status,headers:response.headers});
  const headers=new Headers(response.headers);headers.set("Content-Encoding","gzip");headers.set("Vary","Accept-Encoding");
  return new Response(Bun.gzipSync(bytes,{level:4}),{status:response.status,headers});
}
async function body(request:Request):Promise<Record<string,unknown>> {
  if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))throw new BridgeError("invalid_request","JSON required");
  const length=Number(request.headers.get("content-length"));if(length>MAX_BODY)throw new BridgeError("request_too_large","Body limit",413);
  if(!request.body)throw new BridgeError("invalid_request","Body required");
  const reader=request.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
  while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>MAX_BODY){await reader.cancel();throw new BridgeError("request_too_large","Body limit",413);}chunks.push(next.value);}
  try {const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!value || typeof value!=="object" || Array.isArray(value))throw 0;return value;}catch{throw new BridgeError("invalid_request","Malformed JSON");}
}
class Limiter {
  private counts=new Map<string,{time:number,count:number}>();
  check(key:string,limit:number,window=60_000) {
    const now=Date.now();let item=this.counts.get(key);
    if(!item) {
      if(this.counts.size>=10_000){for(const [k,v]of this.counts)if(now-v.time>60_000)this.counts.delete(k);}
      if(this.counts.size>=10_000)throw new BridgeError("rate_limited","Rate table full",429);
      item={time:now,count:0};this.counts.set(key,item);
    } else if(now-item.time>window){item.time=now;item.count=0;}
    if(++item.count>limit)throw new BridgeError("rate_limited","Rate limit",429);

  }
}
interface SocketData {device:Device;session?:string;generation:number;observer?:TerminalHandle;pane?:string;identity?:string;lease?:string;controllerFrames?:boolean;seq?:number;fitHost?:boolean;skippingSince?:number;size?:{cols:number;rows:number};}
export interface BridgeOptions {
  state:State;backend:HostBackend;hostName?:string;hostname?:string;port?:number;epoch?:string;
  tls?:{cert:string|Bun.BunFile;key:string|Bun.BunFile};leaseMilliseconds?:number;
  /** Additional explicitly authenticated routes, e.g. optional content-free notifications. */
  route?:(request:Request,url:URL,device:Device)=>Promise<Response|undefined>;
  /**
   * Optional same-network pairing. A phone that found this host by Bonjour asks to pair;
   * a short code is shown only on the computer (announce) and typed on the phone.
   */
  nearby?:{scope:Scope;announce(request:{name:string;code:string;expiresAt:string}):void};
  /**
   * Relay-spliced streams arrive on their own loopback listener (`relayServer`), so they are never
   * mistaken for this network: from the bridge's side they would otherwise all come from 127.0.0.1.
   * `phoneURL` and `credentials()` let paired phones swap the relay's shared token for their own.
   */
  relay?:{gateway:GatewayConnection;credentials():boolean};
  /** Addresses this computer can currently be reached at on the local network (`https://ip:port`). */
  localRoutes?:()=>string[];
  /** The serving certificate, and its signed successor while a renewal is pending. */
  certificate?:()=>CertificateStatus;
}
export interface CertificateStatus {pin:string;expiresAt:string;next?:{pin:string;switchAt:string;statement:string;signature:string;previousCertificate:string};}
interface NearbyRequest {id:string;name:string;code:string;expires:number;attempts:number;ip:string}
/** Nearby pairing is for the same network only. */
function localAddress(ip:string){const v=ip.replace(/^::ffff:/,"");return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(v)||v==="::1"||/^(fe80|fc|fd)/i.test(v)||v==="local";}
export function createBridge(options:BridgeOptions) {
  const {state,backend}=options,epoch=options.epoch??randomUUID();
  const controls=new Controls(backend,state,options.leaseMilliseconds);
  const sockets=new Set<ServerWebSocket<SocketData>>();const limiter=new Limiter();
  let stopped=false,requests=0,fileRequests=0;
  const nearby=new Map<string,NearbyRequest>();let nearbyFailures:number[]=[];
  const send=(ws:ServerWebSocket<SocketData>,value:unknown)=>{
    if(!state.active(ws.data.device.id)){ws.close(4001,"Device revoked");return;}
    const text=JSON.stringify(value);
    if(text.length>MAX_RESPONSE || ws.getBufferedAmount()>4_194_304 || ws.send(text)===-1) {ws.close(4008,"Resynchronization required");}
  };
  /** After a device stops viewing a parked pane (not just re-observing it), restore the computer's size. */
  function checkParked(device:string,session:string|undefined,pane:string|undefined) {
    if(!pane)return;const key=controls.key(session,pane),item=controls.parked.get(key);
    if(!item || item.deviceId!==device)return;
    setTimeout(()=>{if(![...sockets].some(ws=>ws.data.device.id===device && ws.data.session===session && ws.data.pane===pane))void controls.restoreParked(key);},2000).unref();
  }
  function clearStream(ws:ServerWebSocket<SocketData>) {
    checkParked(ws.data.device.id,ws.data.session,ws.data.pane);
    ws.data.generation++;ws.data.observer?.close();ws.data.observer=undefined;ws.data.lease=undefined;ws.data.controllerFrames=false;ws.data.pane=undefined;ws.data.identity=undefined;ws.data.seq=undefined;ws.data.skippingSince=undefined;
  }
  function frame(ws:ServerWebSocket<SocketData>,value:TerminalFrame) {
    if(value.identityToken!==ws.data.identity || value.paneId!==ws.data.pane){clearStream(ws);send(ws,{type:"stream_closed",reason:"identity_changed"});return;}
    if((ws.data.seq===undefined && !value.full) || (ws.data.seq!==undefined && !value.full && value.seq!==ws.data.seq+1)) {clearStream(ws);send(ws,{type:"stream_closed",reason:"resync_required"});return;}
    ws.data.seq=value.seq;
    // A slow phone link must not end the stream: skip ahead to the next full frame instead.
    if(ws.data.skippingSince!==undefined || ws.getBufferedAmount()>524_288) {
      if(value.full && ws.getBufferedAmount()<131_072){ws.data.skippingSince=undefined;send(ws,value);return;}
      ws.data.skippingSince??=Date.now();
      if(Date.now()-ws.data.skippingSince>3000 && ws.getBufferedAmount()<131_072){clearStream(ws);send(ws,{type:"stream_closed",reason:"resync_required"});}
      return;
    }
    send(ws,value);
  }
  function attach(ws:ServerWebSocket<SocketData>,lease:Lease):boolean {
    ws.data.lease=lease.leaseId;
    if(!lease.replayable || !lease.frames[0]?.full){ws.data.controllerFrames=false;return false;}
    ws.data.generation++;ws.data.observer?.close();ws.data.observer=undefined;ws.data.controllerFrames=true;ws.data.seq=undefined;
    for(const value of lease.frames)frame(ws,value);
    return true;
  }
  controls.onAcquired=lease=>{for(const ws of sockets)if(ws.data.device.id===lease.deviceId && ws.data.session===lease.session && ws.data.pane===lease.paneId && ws.data.identity===lease.identityToken)attach(ws,lease);};
  controls.onFrame=(lease,value)=>{for(const ws of sockets)if(ws.data.lease===lease.leaseId && ws.data.controllerFrames)frame(ws,value);};
  controls.onReleased=(lease,reason)=>{for(const ws of sockets)if(ws.data.lease===lease.leaseId){clearStream(ws);send(ws,{type:"stream_closed",reason,leaseId:lease.leaseId});}};
  async function websocketMessage(ws:ServerWebSocket<SocketData>,message:string|Buffer) {
    if(!state.active(ws.data.device.id)) {ws.close(4001,"Device revoked");return;}
    if(message.length>16_384)throw new BridgeError("request_too_large","Frame limit",413);
    let value:Record<string,unknown>;try{value=JSON.parse(message.toString());if(!value || typeof value!=="object" || Array.isArray(value))throw 0;}catch{limiter.check(`ws:${ws.data.device.id}`,120,10_000);throw new BridgeError("invalid_request","Invalid frame");}
    // Keystrokes get their own, larger budget; everything else (which can spawn helpers) stays tight.
    if(value.type==="input" || value.type==="scroll")limiter.check(`wsinput:${ws.data.device.id}`,1200,10_000);else limiter.check(`ws:${ws.data.device.id}`,120,10_000);
    if(value.type==="unobserve"){clearStream(ws);return;}
    if(value.type==="input") {
      // Interactive keystrokes for the pane this socket controls. Delivered at most once:
      // nothing is journaled or retried, so a lost socket can never replay typing.
      only(value,["type","leaseId","bytes"]);control(ws.data.device);
      const encoded=str(value.bytes,12_000);
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || Buffer.from(encoded,"base64").toString("base64").replace(/=+$/,"")!==encoded.replace(/=+$/,""))throw new BridgeError("invalid_request","Invalid base64");
      // The lease belongs to this device (controls.get); a re-observe in flight must not drop keys.
      const lease=controls.get(str(value.leaseId),ws.data.device.id);
      if(lease.session!==ws.data.session)throw new BridgeError("forbidden","Lease belongs to another session",403);
      await controls.serial.run(controls.key(lease.session,lease.paneId),async()=>{
        controls.assertActive(lease);
        await deadline(lease.handle!.command({type:"terminal.input",bytes:encoded,encoding:"base64"}),5000,true);
        lease.expires=Date.now()+controls.ttl;
      });
      return;
    }
    if(value.type==="observe") {
      only(value,["type","paneId","identityToken","cols","rows","leaseId","fit"]);
      if(value.fit!==undefined && !["host","client"].includes(String(value.fit)))throw new BridgeError("invalid_request","Invalid fit");
      const pane=str(value.paneId),identity=str(value.identityToken),fitHost=value.fit==="host" && !!backend.paneSize;
      let cols=value.cols===undefined && value.fit==="host"?80:integer(value.cols,20,400),rows=value.rows===undefined && value.fit==="host"?24:integer(value.rows,5,200);
      clearStream(ws);const generation=ws.data.generation;
      await controls.identity(ws.data.session,pane,identity);
      // Host fit observes the computer's exact grid, so the phone can scale it rather than crop it.
      if(fitHost){const size=await deadline(backend.paneSize!(ws.data.session,pane),3000).catch(()=>undefined);if(size){cols=size.cols;rows=size.rows;}}
      if(ws.data.generation!==generation || !sockets.has(ws) || !state.active(ws.data.device.id))return;
      ws.data.pane=pane;ws.data.identity=identity;ws.data.fitHost=fitHost;ws.data.size={cols,rows};
      const lease=value.leaseId?controls.get(str(value.leaseId),ws.data.device.id):controls.matching(ws.data.device.id,ws.data.session,pane);
      if(lease){if(lease.paneId!==pane || lease.session!==ws.data.session || lease.identityToken!==identity)throw new BridgeError("identity_changed","Lease target mismatch",409);if(attach(ws,lease))return;}
      const pending=backend.terminal({session:ws.data.session,paneId:pane,expectedIdentityToken:identity,control:false,takeover:false,cols,rows,
        onFrame:value=>{if(ws.data.generation===generation)frame(ws,value);},
        onClose:reason=>{if(ws.data.generation===generation){clearStream(ws);send(ws,{type:"stream_closed",reason});}}});
      pending.then(handle=>{if(ws.data.generation!==generation || !sockets.has(ws))handle.close();},()=>{});
      const handle=await deadline(pending);
      if(ws.data.generation!==generation || !sockets.has(ws))handle.close();else ws.data.observer=handle;
      return;
    }
    if(value.type==="resize" || value.type==="scroll") {
      control(ws.data.device);const lease=controls.get(str(value.leaseId),ws.data.device.id);
      if(lease.session!==ws.data.session)throw new BridgeError("forbidden","Lease belongs to another session",403);
      await controls.serial.run(controls.key(lease.session,lease.paneId),async()=>{
        controls.assertActive(lease);await controls.identity(lease.session,lease.paneId,lease.identityToken);controls.assertActive(lease);
        if(value.type==="resize"){
          only(value,["type","leaseId","cols","rows","fit"]);
          const size=value.fit==="host"?lease.hostSize:{cols:integer(value.cols,20,400),rows:integer(value.rows,5,200)};
          if(size.cols!==lease.size.cols || size.rows!==lease.size.rows){await deadline(lease.handle!.command({type:"terminal.resize",...size}));lease.size={...size};}
          if(!ws.data.controllerFrames)await websocketMessage(ws,JSON.stringify({type:"observe",paneId:lease.paneId,identityToken:lease.identityToken,leaseId:lease.leaseId,...size}));
        }
        else {
          only(value,["type","leaseId","direction","lines"]);if(!["up","down"].includes(str(value.direction)))throw new BridgeError("invalid_request","Scroll direction");
          const lines=integer(value.lines,1,1000);
          // Herdr turns each terminal.scroll into ONE wheel event for apps that read the mouse or use
          // alternate scroll (Codex, pagers), whatever `lines` says. Send one desktop-sized notch
          // (3 lines) per command so those apps scroll as far as a shell's scrollback does.
          const column=Math.floor(lease.size.cols/2),row=Math.floor(lease.size.rows/2);
          for(let left=lines,n=0;left>0&&n<60;left-=3,n++)await deadline(lease.handle!.command({type:"terminal.scroll",direction:value.direction,lines:Math.min(3,left),column,row}));
          lease.scrolled=Math.max(0,(lease.scrolled??0)+(value.direction==="up"?lines:-lines));
        }
        lease.expires=Date.now()+controls.ttl;
      });return;
    }
    throw new BridgeError("invalid_request","Unknown frame type");
  }
  /** Across all addresses: 20 wrong codes in 10 minutes turns nearby pairing off until restart. */
  let nearbyDisabled=false;
  function nearbyLocked(){
    if(nearbyDisabled)return true;
    const now=Date.now();nearbyFailures=nearbyFailures.filter(t=>now-t<600_000);
    if(nearbyFailures.length>=20){nearbyDisabled=true;nearby.clear();console.error("Nearby pairing turned off after repeated wrong codes. Restart the bridge to allow it again.");}
    return nearbyDisabled;
  }
  async function mutation(device:Device,requestId:unknown,operationKey:unknown,dispatch:()=>Promise<unknown>) {
    control(device);const id=str(requestId,36);if(!UUID.test(id))throw new BridgeError("invalid_request","UUID required");
    const begin=state.begin(device.id,id,hash(canonical(operationKey)));
    if(!begin.fresh)return reply(begin.operation,begin.operation.state==="pending"?202:200);
    try {
      if(!state.active(device.id))throw new BridgeError("invalid_credentials","Revoked",401);
      const result=await deadline(dispatch(),20_000,true).finally(()=>recentSnapshots.clear());
      // Serialize before accepting, so an unbounded result cannot poison the durable journal.
      if(Buffer.byteLength(JSON.stringify(result??null))>MAX_RESPONSE-1024)throw new BridgeError("delivery_unknown","Result too large",503,true);
      return reply(state.finish(device.id,id,"accepted",result??null));
    }catch(error){const f=failure(error);const ambiguous=!(error instanceof Error && "deliveryAmbiguous" in error) || (error as BridgeError).deliveryAmbiguous;if(ambiguous)(f.body as {deliveryAmbiguous?:boolean}).deliveryAmbiguous=true;state.finish(device.id,id,ambiguous?"unknown":"failed",f.body);return reply(f.body,f.status);}
  }
  let relayServer:Bun.Server<SocketData>|undefined;
  const listen=(hostname:string,port:number)=>Bun.serve<SocketData>({
    hostname,port,tls:options.tls,idleTimeout:30,maxRequestBodySize:MAX_BODY,
    websocket:{maxPayloadLength:16_384,idleTimeout:60,backpressureLimit:1_048_576,closeOnBackpressureLimit:true,sendPings:true,
      // Terminal frames are text; clients that offer per-message deflate (Android) get them compressed.
      perMessageDeflate:true,
      open(ws){sockets.add(ws);send(ws,{type:"connected",epoch});},
      message(ws,message){websocketMessage(ws,message).catch(error=>{const f=failure(error);send(ws,{type:"error",...f.body.error});});},
      close(ws){sockets.delete(ws);clearStream(ws);},
    },
    async fetch(request,server) {
      const response=await handle(request,server,server===relayServer);
      return response && compressed(request,response);
    },
    error(){return reply({error:{code:"invalid_request",message:"The request could not be processed."}},400);},
  });
  const server=listen(options.hostname??"127.0.0.1",options.port??0);
  if(options.relay)relayServer=listen("127.0.0.1",0);
  async function handle(request:Request,server:Bun.Server<SocketData>,relayed:boolean):Promise<Response|undefined> {
    {
      if(++requests>64){requests--;return reply({error:{code:"rate_limited",message:"The host is busy."}},429);}
      try {
        const url=new URL(request.url);
        if(request.headers.has("origin"))throw new BridgeError("origin_denied","Browser origin denied",403);
        if(request.headers.has("x-http-method-override"))throw new BridgeError("invalid_request","Method override denied");
        const ip=server.requestIP(request)?.address??"local";
        if(url.pathname==="/health" && request.method==="GET"){limiter.check(`health:${ip}`,120);return reply({protocolVersion:1,available:!stopped});}
        if(url.pathname==="/v1/pair" && request.method==="POST") {
          limiter.check(`pair:${ip}`,10);const value=await body(request);only(value,["code","name"]);
          const result=state.pair(str(value.code,64,43),str(value.name,100));
          return reply({hostId:state.hostId,hostName:options.hostName??"Herdr host",...result,protocolVersion:1},201);
        }
        if(url.pathname==="/v1/pair/nearby" && request.method==="POST") {
          if(!options.nearby || nearbyLocked())throw new BridgeError("unsupported","Nearby pairing is off",501);
          if(relayed || !localAddress(ip))throw new BridgeError("forbidden","Nearby pairing is limited to the local network",403);
          limiter.check(`nearby:${ip}`,4);const value=await body(request);only(value,["name"]);
          const now=Date.now();for(const [id,item]of nearby)if(item.expires<=now)nearby.delete(id);
          if(nearby.size>=8 || [...nearby.values()].filter(n=>n.ip===ip).length>=2)throw new BridgeError("rate_limited","Too many pairing requests",429);
          const item:NearbyRequest={id:randomUUID(),name:str(value.name,100),code:String(randomInt(0,1_000_000)).padStart(6,"0"),expires:now+120_000,attempts:0,ip};
          nearby.set(item.id,item);const expiresAt=new Date(item.expires).toISOString();
          try{options.nearby.announce({name:item.name,code:item.code,expiresAt});}catch{}
          return reply({requestId:item.id,expiresAt},201);
        }
        if(url.pathname==="/v1/pair/nearby/confirm" && request.method==="POST") {
          if(!options.nearby || nearbyLocked())throw new BridgeError("unsupported","Nearby pairing is off",501);
          if(relayed || !localAddress(ip))throw new BridgeError("forbidden","Nearby pairing is limited to the local network",403);
          limiter.check(`nearby-confirm:${ip}`,30);const value=await body(request);only(value,["requestId","code"]);
          const item=nearby.get(str(value.requestId,36)),code=str(value.code,6,6);
          if(!item || item.expires<=Date.now()){if(item)nearby.delete(item.id);throw new BridgeError("invitation_expired","Pairing request expired",410);}
          if(++item.attempts>5){nearby.delete(item.id);throw new BridgeError("invitation_expired","Too many attempts",410);}
          if(!/^\d{6}$/.test(code) || !timingSafeEqual(Buffer.from(code),Buffer.from(item.code))){nearbyFailures.push(Date.now());throw new BridgeError("invalid_code","Wrong code",403);}
          nearby.delete(item.id);
          const result=state.pair(state.invite(options.nearby.scope,60).code,item.name);
          // Paired at home, reachable away: a relayed bridge hands the phone its route with the phone's own credential.
          const connection=options.relay?.credentials()?{mode:"gateway",gateway:{...options.relay.gateway,token:state.relayCredential(result.deviceId)}}:undefined;
          return reply({hostId:state.hostId,hostName:options.hostName??"Herdr host",...result,protocolVersion:1,...(connection?{connection}:{})},201);
        }
        if(!url.pathname.startsWith("/v1/"))throw new BridgeError("not_found","Unknown route",404);
        const authorization=request.headers.get("authorization")??"";
        if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)){limiter.check(`auth:${ip}`,30);throw new BridgeError("invalid_credentials","Invalid credential",401);}
        let device:Device;try{device=state.authenticate(authorization.slice(7));}catch(error){limiter.check(`auth:${ip}`,30);throw error;}limiter.check(`http:${device.id}`,2400);
        const session=url.searchParams.has("session")?str(url.searchParams.get("session"),128):undefined;
        const paneId=url.searchParams.has("paneId")?str(url.searchParams.get("paneId")):undefined;
        const additional=await options.route?.(request,url,device);if(additional)return additional;
        if(url.pathname==="/v1/relay/credential" && request.method==="POST") {
          // Transport only: any paired device may replace the relay's shared token with its own.
          if(!options.relay?.credentials())throw new BridgeError("unsupported","This relay does not issue device credentials",501);
          limiter.check(`relay-credential:${device.id}`,5,600_000);
          return reply({url:options.relay.gateway.url,token:state.relayCredential(device.id)},201);
        }
        if(url.pathname==="/v1/certificate" && request.method==="GET") {
          if(!options.certificate)throw new BridgeError("unsupported","Certificate status unavailable",501);
          return reply(options.certificate());
        }
        if(url.pathname==="/v1/live" && request.method==="GET") {
          if([...sockets].filter(ws=>ws.data.device.id===device.id).length>=4 || sockets.size>=64)throw new BridgeError("rate_limited","Socket limit",429);
          if(server.upgrade(request,{data:{device,session,generation:0}}))return;
          throw new BridgeError("invalid_request","WebSocket upgrade required");
        }
        const parts=url.pathname.split("/").filter(Boolean).map(part=>{try{return str(decodeURIComponent(part));}catch{throw new BridgeError("invalid_request","Malformed path");}});
        if(request.method==="GET") {
          if(url.pathname==="/v1/snapshot"){const value=await deadline(snapshotOf(session));return reply({...value,capabilities:{...(value.capabilities as object|undefined),liveInput:true,hostSizedTerminal:!!backend.paneSize,...(options.certificate?{certificateRenewal:true}:{}),...(options.relay?.credentials()?{relayCredential:true}:{})},...(options.localRoutes?{routes:{local:options.localRoutes()}}:{}),hostId:state.hostId,epoch});}
          if(parts[1]==="operations" && parts.length===3){if(!UUID.test(parts[2]!))throw new BridgeError("invalid_request","Invalid operation ID");return reply(state.operation(device.id,parts[2]!));}
          if(parts[1]==="panes" && parts.length===4){
            if(parts[3]==="output"){const lines=url.searchParams.has("lines")?integer(Number(url.searchParams.get("lines")),1,2000):240;return reply(await deadline(backend.output(session,parts[2]!,lines)));}
            if(parts[3]==="transcript"){const cursor=url.searchParams.has("cursor")?str(url.searchParams.get("cursor"),4096):undefined;const earlier=url.searchParams.has("before")?str(url.searchParams.get("before"),4096):undefined;return reply(await deadline(backend.transcript(session,parts[2]!,earlier?undefined:cursor,earlier??url.searchParams.get("tail")==="1")));}
          }
          if(parts[1]==="workspaces" && parts.length===4){
            const path=url.searchParams.has("path")?str(url.searchParams.get("path"),4096,0):"";
            if(parts[3]==="git")return reply(await deadline(backend.git(session,parts[2]!,paneId)));
            if(parts[3]==="diff")return reply(await deadline(backend.diff(session,parts[2]!,path,paneId)));
            if(parts[3]==="files")return reply(await deadline(backend.files(session,parts[2]!,path,paneId)));
            if(parts[3]==="file"){if(fileRequests>=4)throw new BridgeError("rate_limited","File reader limit",429);fileRequests++;try{return reply(await deadline(backend.file(session,parts[2]!,path,paneId)),200,MAX_FILE_RESPONSE);}finally{fileRequests--;}}
          }
        }
        if(["POST","DELETE"].includes(request.method)) {
          control(device);limiter.check(`write:${device.id}`,1200);
          if(parts[1]==="control" && parts.length===3) {
            const lease=controls.get(parts[2]!,device.id); // DELETE has no body.
            if(request.method==="DELETE"){
              // Still looking at it on this device: keep the phone-fitted size until the device leaves the pane.
              const viewing=[...sockets].some(ws=>ws.data.device.id===device.id && ws.data.session===lease.session && ws.data.pane===lease.paneId);
              controls.release(lease,"released",viewing);return reply({released:true});
            }
          }
          if(parts[1]==="control" && parts.length===4 && parts[3]==="renew" && request.method==="POST")return reply(controls.dto(controls.renew(parts[2]!,device.id)));
          const value=await body(request);
          if(parts[1]==="panes" && parts.length===4 && parts[3]==="control" && request.method==="POST") {
            only(value,["identityToken","takeover"]);if(value.takeover!==undefined && typeof value.takeover!=="boolean")throw new BridgeError("invalid_request","Invalid takeover");
            return reply(controls.dto(await controls.acquire(device.id,session,parts[2]!,str(value.identityToken),value.takeover===true)));
          }
          if(parts[1]==="panes" && parts.length===4 && parts[3]==="input" && request.method==="POST") {
            only(value,["requestId","leaseId","identityToken","text","bytes","keys","submit"]);
            const leaseId=str(value.leaseId),token=str(value.identityToken);
            const count=["text","bytes","keys"].filter(key=>value[key]!==undefined).length;
            if(count!==1 || (value.submit!==undefined && typeof value.submit!=="boolean") || (value.submit===true && value.text===undefined))throw new BridgeError("invalid_request","Invalid input representation");
            let bytes:string|undefined;
            if(value.text!==undefined)str(value.text,32_768,0);
            if(value.bytes!==undefined){const encoded=str(value.bytes,32_768);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||Buffer.from(encoded,"base64").toString("base64").replace(/=+$/,"")!==encoded.replace(/=+$/,""))throw new BridgeError("invalid_request","Invalid base64");bytes=encoded;}
            if(value.keys!==undefined){if(!Array.isArray(value.keys)||value.keys.length<1||value.keys.length>64)throw new BridgeError("invalid_request","Invalid keys");const keymap:Record<string,string>={enter:"\r",escape:"\x1b",tab:"\t",backspace:"\x7f",delete:"\x1b[3~",up:"\x1b[A",down:"\x1b[B",right:"\x1b[C",left:"\x1b[D",home:"\x1b[H",end:"\x1b[F",pageUp:"\x1b[5~",pageDown:"\x1b[6~",ctrlC:"\x03",ctrlD:"\x04",ctrlZ:"\x1a",ctrlL:"\x0c"};bytes=Buffer.from(value.keys.map(key=>{const sequence=keymap[str(key,16)];if(!sequence)throw new BridgeError("invalid_request","Unknown key");return sequence;}).join("")).toString("base64");}
            return await mutation(device,value.requestId,{route:url.pathname,session:session??null,body:value},()=>controls.serial.run(controls.key(session,parts[2]!),async()=>{
              if(state.operation(device.id,value.requestId as string).state!=="pending")throw new BridgeError("delivery_unknown","Operation no longer pending",503,true);
              const lease=controls.get(leaseId,device.id);if(lease.paneId!==parts[2] || lease.session!==session || lease.identityToken!==token)throw new BridgeError("identity_changed","Wrong target",409);
              await controls.identity(session,parts[2]!,token);controls.assertActive(lease);
              if(state.operation(device.id,value.requestId as string).state!=="pending")throw new BridgeError("delivery_unknown","Operation no longer pending",503,true);
              lease.expires=Date.now()+controls.ttl;
              if(value.text!==undefined)return deadline(backend.submitText(session,parts[2]!,value.text as string,value.submit===true,token),15_000,true);
              await deadline(lease.handle!.command({type:"terminal.input",bytes,encoding:"base64"}),15_000,true);return {admitted:true};
            }));
          }
          let kind:"workspace.create"|"tab.create"|"pane.split"|"pane.close"|"agent.start"|undefined;
          if(url.pathname==="/v1/workspaces" && request.method==="POST"){only(value,["requestId","cwd","label"]);str(value.cwd,4096);if(value.label!==undefined)str(value.label,100);kind="workspace.create";}
          else if(url.pathname==="/v1/tabs" && request.method==="POST"){only(value,["requestId","workspaceId","cwd","label"]);str(value.workspaceId);if(value.cwd!==undefined)str(value.cwd,4096);if(value.label!==undefined)str(value.label,100);kind="tab.create";}
          else if(parts[1]==="panes" && parts.length===4 && parts[3]==="split" && request.method==="POST"){only(value,["requestId","identityToken","direction","cwd"]);str(value.identityToken);if(!["right","down"].includes(str(value.direction)))throw new BridgeError("invalid_request","Invalid split");if(value.cwd!==undefined)str(value.cwd,4096);kind="pane.split";value.paneId=parts[2];}
          else if(parts[1]==="panes" && parts.length===3 && request.method==="DELETE"){only(value,["requestId","identityToken"]);str(value.identityToken);kind="pane.close";value.paneId=parts[2];}
          else if(url.pathname==="/v1/agents" && request.method==="POST"){only(value,["requestId","paneId","identityToken","kind","name"]);str(value.paneId);str(value.identityToken);str(value.kind,32);str(value.name,100);kind="agent.start";}
          if(kind){const selected=kind;return await mutation(device,value.requestId,{route:url.pathname,session:session??null,body:value},async()=>{
            const dispatch=async()=>{if(state.operation(device.id,value.requestId as string).state!=="pending")throw new BridgeError("delivery_unknown","Operation no longer pending",503,true);if(value.paneId)await controls.identity(session,value.paneId as string,value.identityToken as string);if(!state.active(device.id))throw new BridgeError("invalid_credentials","Revoked",401);if(state.operation(device.id,value.requestId as string).state!=="pending")throw new BridgeError("delivery_unknown","Operation no longer pending",503,true);return deadline(backend.mutate(selected,session,value),15_000,true);};
            return value.paneId?controls.serial.run(controls.key(session,value.paneId as string),dispatch):dispatch();
          });}
        }
        throw new BridgeError("not_found","Unknown route",404);
      }catch(error){const f=failure(error);return reply(f.body,f.status);}finally{requests--;}
    }
  }
  // Revalidate independently of a cooperative client's snapshot refresh. Only active targets are polled.
  let checkingIdentities=false;
  async function revalidateStreams() {
    if(checkingIdentities || stopped)return;checkingIdentities=true;
    try {
      const targets=new Map<string,{session?:string,pane:string}>();
      for(const ws of sockets)if(ws.data.pane)targets.set(controls.key(ws.data.session,ws.data.pane),{session:ws.data.session,pane:ws.data.pane});
      for(const lease of controls.leases.values())targets.set(controls.key(lease.session,lease.paneId),{session:lease.session,pane:lease.paneId});
      const list=[...targets.values()];
      for(let index=0;index<list.length && !stopped;index+=8)await Promise.all(list.slice(index,index+8).map(async target=>{
        let token:string|undefined;
        try{token=(await deadline(backend.identity(target.session,target.pane),3000)).identityToken;}catch{}
        if(stopped)return;
        for(const lease of controls.leases.values())if(lease.session===target.session && lease.paneId===target.pane && lease.identityToken!==token)controls.release(lease,token?"identity_changed":"host_unavailable");
        for(const ws of sockets)if(ws.data.session===target.session && ws.data.pane===target.pane && ws.data.identity!==token){clearStream(ws);send(ws,{type:"stream_closed",reason:token?"identity_changed":"host_unavailable"});}
      }));
    }finally{checkingIdentities=false;}
  }
  const identitySweep=setInterval(()=>{void revalidateStreams();},2000);identitySweep.unref();
  // A change found by the watcher below makes every phone in that session fetch the snapshot at once:
  // they share the watcher's read (or one fresh read) instead of each walking every pane again.
  const recentSnapshots=new Map<string,{at:number;value:Promise<Record<string,unknown>>}>();
  function snapshotOf(session:string|undefined):Promise<Record<string,unknown>> {
    const key=session??"",hit=recentSnapshots.get(key),now=Date.now();
    if(hit && now-hit.at<1000)return hit.value;
    const value=backend.snapshot(session) as Promise<Record<string,unknown>>;
    recentSnapshots.set(key,{at:now,value});
    value.catch(()=>{if(recentSnapshots.get(key)?.value===value)recentSnapshots.delete(key);});
    if(recentSnapshots.size>64)for(const [k,v]of recentSnapshots)if(now-v.at>=1000)recentSnapshots.delete(k);
    return value;
  }
  // Notify sockets only when their session's snapshot actually changes, instead of every tick.
  const fingerprints=new Map<string,string>();let watching=false;
  async function watchSnapshots() {
    if(watching || stopped)return;watching=true;
    try {
      const sessions=new Set<string|undefined>();for(const ws of sockets)sessions.add(ws.data.session);
      for(const key of [...fingerprints.keys()])if(![...sessions].some(s=>(s??"")===key))fingerprints.delete(key);
      for(const session of sessions) {
        let value:Record<string,unknown>;try{value=await deadline(snapshotOf(session),3000);}catch{continue;}
        if(stopped)return;
        const print=hash(canonical(value,new Set(["ts","revision"]))),key=session??"",previous=fingerprints.get(key);
        fingerprints.set(key,print);
        if(previous!==undefined && previous!==print)for(const ws of sockets)if((ws.data.session??"")===key)send(ws,{type:"snapshot_changed"});
      }
    }finally{watching=false;}
  }
  // Host-fit observers follow the computer when its pane is resized.
  let following=false;
  async function followPaneSizes() {
    if(!backend.paneSize || following || stopped)return;following=true;
    try{for(const ws of sockets) {
      if(!ws.data.fitHost || !ws.data.pane || !ws.data.identity || !ws.data.observer || ws.data.controllerFrames)continue;
      const generation=ws.data.generation,pane=ws.data.pane,identity=ws.data.identity;
      const size=await deadline(backend.paneSize(ws.data.session,pane),3000).catch(()=>undefined);
      if(!size || ws.data.generation!==generation || !sockets.has(ws))continue;
      // Ask the client to resubscribe so it starts cleanly from a new full frame at the new size.
      if(size.cols!==ws.data.size?.cols || size.rows!==ws.data.size?.rows){clearStream(ws);send(ws,{type:"stream_closed",reason:"resync_required"});}
    }}finally{following=false;}
  }
  let tick=0;
  const sweep=setInterval(()=>{
    controls.sweep();for(const ws of sockets){
      if(!state.active(ws.data.device.id)){clearStream(ws);ws.close(4001,"Device revoked");}
      // An idle pane sends no further full frame; resubscribe once the link has drained.
      else if(ws.data.skippingSince!==undefined && Date.now()-ws.data.skippingSince>3000 && ws.getBufferedAmount()<131_072){clearStream(ws);send(ws,{type:"stream_closed",reason:"resync_required"});}
    }
    // A large Herdr session can take ~0.5s to snapshot; every other tick keeps that load modest.
    if(++tick%2===0)void followPaneSizes();else void watchSnapshots();
  },1000);sweep.unref();
  return {server,relayServer,controls,epoch,
    revoke(device:string){state.revoke(device);controls.revoke(device);for(const ws of sockets)if(ws.data.device.id===device){clearStream(ws);ws.close(4001,"Device revoked");}},
    close(){if(stopped)return;stopped=true;clearInterval(sweep);clearInterval(identitySweep);controls.close();for(const ws of sockets)ws.close(1001,"Server shutdown");backend.close();server.stop(true);relayServer?.stop(true);},
  };
}
