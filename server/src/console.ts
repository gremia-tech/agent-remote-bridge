// Local web console for the bridge. Plain HTTP on loopback only, never the phone port: it uses browser
// cookies, which the bearer-only phone API must not. A browser gets in through a one-time launch secret
// that only this OS user can mint (a private file in the state directory), then holds an HttpOnly
// SameSite=Strict session. Host, Origin and a CSRF header are checked so other web pages and rebound
// hostnames cannot drive it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import { loadConfig, saveConfig, certificatePin, type Config } from "./config";
import { relayProfile, readRelayProfile } from "./relay";
import { connectionProfile, type HostConnection } from "./connection";
import { certificateStatus, renewCertificate } from "./certificate";
import type { Services } from "./services";
import { consolePage } from "./console-page";

const LAUNCH_SECONDS=120,SESSION_MS=12*3_600_000,MAX_BODY=16_384;
const launchFile=(directory:string)=>join(directory,"console-launch.json"),portFile=(directory:string)=>join(directory,"console.json");
function privateWrite(path:string,text:string){writeFileSync(path,text,{mode:0o600});chmodSync(path,0o600);}
/** Mint a one-time link to the console. Only someone who can write the state directory can do this. */
export function consoleLaunchURL(directory:string,fallbackPort=8790) {
  let port=fallbackPort;
  try{const running=JSON.parse(readFileSync(portFile(directory),"utf8")) as {port:number;pid:number};process.kill(running.pid,0);port=running.port;}
  catch{if(existsSync(portFile(directory)))throw new Error("The bridge console is not running. Start the bridge with serve or up.");}
  const secret=randomBytes(32).toString("base64url");
  privateWrite(launchFile(directory),JSON.stringify({secret,expires:Date.now()+LAUNCH_SECONDS*1000}));
  return `http://127.0.0.1:${port}/#launch=${secret}`;
}
/** Open a link without putting its secret on a command line other users can read: a private redirect file. */
export function openBrowser(url:string,directory?:string) {
  const command=process.platform==="darwin"?"open":process.env.DISPLAY||process.env.WAYLAND_DISPLAY?Bun.which("xdg-open"):null;
  if(!command)return false;
  let target=url;
  if(directory){const file=join(directory,"console-open.html");privateWrite(file,`<!doctype html><meta charset="utf-8"><script>location.replace(${JSON.stringify(url)})</script>`);target=`file://${file}`;setTimeout(()=>{try{unlinkSync(file);}catch{}},30_000).unref();}
  try{spawn(command,[target],{stdio:"ignore",detached:true}).on("error",()=>{}).unref();return true;}catch{return false;}
}
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function json(value:unknown,status=200,headers:Record<string,string>={}) {
  return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...headers}});
}
class ConsoleError extends Error {constructor(readonly status:number,message:string){super(message);}}
const fail=(status:number,message:string)=>{throw new ConsoleError(status,message);};
interface Session {csrf:string;expires:number}
export interface ConsoleOptions {directory:string;port:number;services:()=>Services|undefined;restart:()=>Promise<void>;saved?:(keys:string[])=>void;effective?:()=>Partial<Config>;version:string}
export function startConsole(options:ConsoleOptions) {
  const {directory}=options,sessions=new Map<string,Session>();
  let failures=0,failureWindow=Date.now(),server:ReturnType<typeof Bun.serve>|undefined;
  for(let port=options.port;port<options.port+10&&!server;port++) {
    try{server=Bun.serve({hostname:"127.0.0.1",port,fetch:request=>handle(request).catch(error=>json({error:error instanceof ConsoleError?error.message:"The console could not complete this request."},error instanceof ConsoleError?error.status:500))});}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EADDRINUSE")throw error;}
  }
  if(!server)throw new Error(`No free console port from ${options.port} to ${options.port+9}; set consolePort or use --no-console`);
  const port=server.port!;
  privateWrite(portFile(directory),JSON.stringify({port,pid:process.pid}));
  const origins=[`http://127.0.0.1:${port}`,`http://localhost:${port}`];
  function session(request:Request,write:boolean):Session {
    const id=/(?:^|;\s*)hmr_console=([A-Za-z0-9_-]{43})/.exec(request.headers.get("cookie")??"")?.[1],item=id?sessions.get(id):undefined;
    if(!item||item.expires<Date.now())fail(401,"Open the console again from the bridge: run herdr-remote console");
    if(write&&!equal(request.headers.get("x-console-csrf")??"",item!.csrf))fail(403,"Missing console token");
    item!.expires=Date.now()+SESSION_MS;return item!;
  }
  async function body(request:Request):Promise<Record<string,unknown>> {
    if(!request.headers.get("content-type")?.startsWith("application/json"))fail(400,"JSON required");
    const text=await request.text();if(text.length>MAX_BODY)fail(413,"Too large");
    try{const value=JSON.parse(text||"{}");if(!value||typeof value!=="object"||Array.isArray(value))throw 0;return value;}catch{return fail(400,"Malformed JSON");}
  }
  const running=()=>options.services()??fail(503,"The bridge is restarting");
  async function handle(request:Request):Promise<Response> {
    const url=new URL(request.url);
    // Only loopback names: a DNS-rebound hostname pointing here is refused before anything else.
    if(!origins.some(origin=>new URL(origin).host===request.headers.get("host")))return new Response("Forbidden\n",{status:403});
    if(request.method!=="GET"&&!origins.includes(request.headers.get("origin")??""))fail(403,"Cross-origin request refused");
    if(url.pathname==="/"&&request.method==="GET")return new Response(consolePage,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Frame-Options":"DENY","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'","Referrer-Policy":"no-referrer"}});
    if(url.pathname==="/api/session"&&request.method==="POST") {
      if(Date.now()-failureWindow>60_000){failures=0;failureWindow=Date.now();}
      if(failures>=20)fail(429,"Too many attempts");
      const {launch}=await body(request);let stored:{secret:string;expires:number}|undefined;
      try{const file=lstatSync(launchFile(directory));if(file.isFile()&&!file.isSymbolicLink()&&(file.mode&0o077)===0)stored=JSON.parse(readFileSync(launchFile(directory),"utf8"));}catch{}
      if(typeof launch!=="string"||!stored||stored.expires<Date.now()||!equal(launch,stored.secret)){failures++;fail(401,"This console link was already used or has expired. Run herdr-remote console for a new one.");}
      unlinkSync(launchFile(directory));
      const id=randomBytes(32).toString("base64url"),csrf=randomBytes(32).toString("base64url");
      for(const [key,value]of sessions)if(value.expires<Date.now())sessions.delete(key);
      sessions.set(id,{csrf,expires:Date.now()+SESSION_MS});
      return json({csrf},201,{"Set-Cookie":`hmr_console=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}`});
    }
    if(url.pathname==="/api/session"&&request.method==="GET")return json({csrf:session(request,false).csrf});
    if(!url.pathname.startsWith("/api/"))return new Response("Not found\n",{status:404});
    const write=request.method!=="GET";session(request,write);
    const parts=url.pathname.split("/").filter(Boolean);
    if(url.pathname==="/api/status"&&!write)return json(status());
    // Values set by command-line flags for this run are shown as they are in effect.
    if(url.pathname==="/api/config"&&!write)return json({...editable(loadConfig(directory)),...options.effective?.()});
    if(url.pathname==="/api/config"&&request.method==="PUT") {
      const before=loadConfig(directory),value=await body(request),next=merge(before,value);saveConfig(directory,next);
      options.saved?.(Object.keys(value).filter(key=>JSON.stringify((before as unknown as Record<string,unknown>)[key])!==JSON.stringify((next as unknown as Record<string,unknown>)[key])));
      return json({saved:true,restartRequired:true});
    }
    if(url.pathname==="/api/restart"&&request.method==="POST"){await options.restart();return json({restarted:true});}
    if(url.pathname==="/api/devices"&&!write)return json(running().state.devices().map(({id,name,scope,createdAt,revokedAt})=>({id,name,scope,createdAt,revokedAt})));
    if(parts[1]==="devices"&&parts.length===4&&request.method==="POST") {
      const id=parts[2]!;if(!/^[0-9a-f-]{36}$/.test(id))fail(400,"Invalid device");
      if(parts[3]==="revoke"){running().bridge.revoke(id);return json({revoked:true});}
      if(parts[3]==="rename"){const {name}=await body(request);if(typeof name!=="string"||!name.trim()||name.length>100)fail(400,"Invalid name");return json({renamed:running().state.rename(id,(name as string).trim())});}
    }
    if(url.pathname==="/api/pair"&&request.method==="POST") {
      const {scope,ttl}=await body(request);if(scope!=="read"&&scope!=="control")fail(400,"Scope must be read or control");
      const seconds=Number(ttl??300);if(!Number.isInteger(seconds)||seconds<60||seconds>3600)fail(400,"Lifetime must be 60 to 3600 seconds");
      return json(await invitation(scope as "read"|"control",seconds));
    }
    if(url.pathname==="/api/relay/join"&&request.method==="POST") {
      const {profile}=await body(request);let parsed;
      try{parsed=relayProfile(typeof profile==="string"?JSON.parse(profile):profile);}catch(error){return fail(400,error instanceof Error?error.message:"Invalid relay profile");}
      privateWrite(join(directory,"relay.json"),JSON.stringify(parsed,null,2)+"\n");return json({joined:true,restartRequired:true});
    }
    if(url.pathname==="/api/relay/leave"&&request.method==="POST"){const file=join(directory,"relay.json");if(existsSync(file))unlinkSync(file);return json({left:true,restartRequired:true});}
    if(url.pathname==="/api/certificate/renew"&&request.method==="POST") {
      const {days}=await body(request),value=Number(days??14);if(!Number.isFinite(value)||value<0||value>365)fail(400,"Days must be 0 to 365");
      await renewCertificate(loadConfig(directory),running().state.hostId,new Date(Date.now()+value*86_400_000));return json({renewed:true});
    }
    return fail(404,"Unknown console route");
  }
  function status() {
    const services=options.services(),config=loadConfig(directory),relayFile=join(directory,"relay.json");
    let relayHost:string|undefined;try{if(existsSync(relayFile))relayHost=new URL(readRelayProfile(relayFile).host.url).host;}catch{}
    const certificate=services?certificateStatus(config,services.state.hostId):undefined;
    return {version:options.version,running:!!services,
      bridge:services?{hostId:services.state.hostId,hostName:config.hostName,url:config.url,listen:services.listen,port:services.port,backend:services.backend,discoverable:services.discoverable,localRoute:services.localRoute,startedAt:services.startedAt,
        localAddresses:services.localRoutes(),devices:services.state.devices().filter(d=>!d.revokedAt).length}:undefined,
      relay:relayHost?{host:relayHost,...(services?.relay?.status??{connected:false})}:undefined,
      certificate:certificate?{pin:certificate.pin,expiresAt:certificate.expiresAt,...(certificate.next?{next:{pin:certificate.next.pin,switchAt:certificate.next.switchAt}}:{})}:undefined};
  }
  async function invitation(scope:"read"|"control",ttl:number) {
    const services=running(),config=services.config,relayFile=join(directory,"relay.json");
    let connection:HostConnection|undefined;
    if(existsSync(relayFile))connection=connectionProfile(readRelayProfile(relayFile).phone,config.url);
    const {relayToken,...invite}=services.state.invite(scope,ttl,!!connection&&services.state.metadata("relayRevision")==="2");
    if(relayToken&&connection?.mode==="gateway")connection={mode:"gateway",gateway:{...connection.gateway,token:relayToken}};
    const data={version:connection?2:1,url:config.url,certificateSHA256:certificatePin(config.certificate),...invite,...(connection?{connection}:{})};
    const uri=`herdr-remote://pair?data=${Buffer.from(JSON.stringify(data)).toString("base64url")}`;
    return {svg:await QRCode.toString(uri,{type:"svg",errorCorrectionLevel:"M",margin:2}),expiresAt:invite.expiresAt,scope,relay:!!connection};
  }
  return {port,launchURL:()=>consoleLaunchURL(directory,port),close(){server?.stop(true);try{unlinkSync(portFile(directory));}catch{}}};
}
const EDITABLE=["hostName","listen","port","backend","herdr","session","discoverable","nearbyScope","localRoute","console","consolePort"] as const;
function editable(config:Config){return Object.fromEntries(EDITABLE.map(key=>[key,config[key]??null]));}
/** Only known fields, each validated; the rest of the config (paths, URL, keys) is not editable here. */
function merge(config:Config,value:Record<string,unknown>):Config {
  if(Object.keys(value).some(key=>!(EDITABLE as readonly string[]).includes(key)))fail(400,"Unknown setting");
  const next={...config} as Record<string,unknown>,text=(v:unknown,max=200)=>typeof v==="string"&&v.trim().length>0&&v.length<=max&&!/[\0\r\n]/.test(v);
  for(const [key,v] of Object.entries(value)) {
    if(v===null){if(["session","discoverable","nearbyScope","localRoute","console","consolePort"].includes(key)){delete next[key];continue;}fail(400,`${key} cannot be empty`);}
    if(key==="port"||key==="consolePort"){if(!Number.isInteger(v)||(v as number)<1||(v as number)>65535)fail(400,`${key} must be a TCP port`);}
    else if(key==="listen"){if(typeof v!=="string"||!/^(\d{1,3}(\.\d{1,3}){3}|::|::1|localhost)$/.test(v))fail(400,"Listen address must be an IP address, :: or localhost");}
    else if(key==="backend"){if(!["herdr","orca","plain"].includes(v as string))fail(400,"Unknown backend");if(v==="orca"&&!config.orcaConnection)fail(400,"Set up Orca with init --orca-connection first");}
    else if(key==="nearbyScope"){if(v!=="read"&&v!=="control")fail(400,"Nearby scope must be read or control");}
    else if(["discoverable","localRoute","console"].includes(key)){if(typeof v!=="boolean")fail(400,`${key} must be true or false`);}
    else if(!text(v))fail(400,`Invalid ${key}`);
    next[key]=v;
  }
  if(next.port===next.consolePort)fail(400,"The console needs its own port");
  return next as unknown as Config;
}
