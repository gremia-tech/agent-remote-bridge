#!/usr/bin/env bun
import { homedir, hostname } from "node:os";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { chmodSync, readFileSync, writeFileSync, unlinkSync, existsSync, lstatSync } from "node:fs";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { State, privateDirectory } from "./state";
import { initialize, loadConfig, certificatePin } from "./config";
import { createBridge } from "./app";
import { createHerdrBackend, type HostBackend } from "./backend/index";
import { createOrcaBackend } from "./backend/orca";
import { createPlainBackend } from "./backend/plain";
import { loadOrcaConnection } from "./backend/orca/connection";
import { createNotifications } from "../notifications/index";
import { randomUUID } from "node:crypto";
import { connectionProfile } from "./connection";
import { advertise, lanAddresses, localHostname } from "./discovery";
import { connectRelay, createRelay, readRelayProfile, relayProfileFor, relaySecrets } from "./relay";
process.umask(0o077);
// Release builds stamp their version with --define HERDR_REMOTE_VERSION='"x.y.z"'.
declare const HERDR_REMOTE_VERSION:string|undefined;
const version=typeof HERDR_REMOTE_VERSION==="string"?HERDR_REMOTE_VERSION:"0.1.0";
const usage=`Herdr Remote host ${version}
  herdr-remote up [--port 8443] [--name NAME] [--no-discovery] [--backend herdr|orca|plain]
      One step for a computer on your Wi-Fi: creates TLS material on first run, then serves
      and advertises this computer so the phone app finds it under Nearby. Pairing needs the
      code that pops up on this computer.
  herdr-remote init --url https://host.example:8443 [--listen 127.0.0.1] [--port 8443] [--san localhost,127.0.0.1]
  herdr-remote serve [--backend herdr|orca|plain] [--herdr /path/to/herdr] [--session NAME] [--discoverable]
  Orca init/serve: --backend orca --orca-connection /private/orca-access.txt (local runtime link)
  Plain terminals (no Herdr or Orca): --backend plain [--folder DIR]... the bridge runs its own shells;
    folders become workspaces (default: your home folder, then whatever you add from the phone)
  herdr-remote pair [--scope read|control] [--ttl 300] [--qr] [--connection PRIVATE_PROFILE.json] [--no-relay]
  herdr-remote devices
  herdr-remote revoke --device UUID
Reach this computer from anywhere through a relay you run (it dials out; no inbound port):
  herdr-remote relay join PRIVATE_RELAY.json   then serve/up connect to it and pair invitations use it
  herdr-remote relay status | leave
  On the relay server: herdr-remote relay serve [--listen 127.0.0.1] [--port 8788] [--state DIR]
    and herdr-remote relay profile --public-url wss://relay.example.com > PRIVATE_RELAY.json
    (relay state defaults to ~/.local/share/herdr-remote-relay; put it behind HTTPS/WSS)
All commands accept --state DIR (default ~/.local/share/herdr-remote).
Pairing output contains a short-lived secret. Share it only with the device owner.
An existing certificate is never silently rotated. Renew expired TLS material deliberately and re-pair devices.`;
export async function main(args=process.argv.slice(2)) {
  const parsed=parseArgs({args,allowPositionals:true,strict:true,options:{
    backend:{type:"string"},folder:{type:"string",multiple:true},"orca-connection":{type:"string"},state:{type:"string"},url:{type:"string"},listen:{type:"string"},port:{type:"string"},san:{type:"string"},herdr:{type:"string"},session:{type:"string"},name:{type:"string"},scope:{type:"string"},ttl:{type:"string"},device:{type:"string"},connection:{type:"string"},qr:{type:"boolean"},help:{type:"boolean"},json:{type:"boolean"},discoverable:{type:"boolean"},"no-discovery":{type:"boolean"},"no-relay":{type:"boolean"},"public-url":{type:"string"},
  }});
  let command=parsed.positionals[0];const v=parsed.values;
  if(v.backend&&!['herdr','orca','plain'].includes(v.backend))throw new Error("--backend must be herdr, orca or plain");
  if(v["orca-connection"])loadOrcaConnection(v["orca-connection"]);
  if(v.help || !command){console.log(usage);return;}
  if(command==="relay"&&["serve","profile"].includes(parsed.positionals[1]??"")) {
    const secrets=relaySecrets(resolve(v.state??join(homedir(),".local/share/herdr-remote-relay")));
    if(parsed.positionals[1]==="profile") {
      if(!v["public-url"])throw new Error("relay profile requires --public-url wss://relay.example.com");
      console.log(JSON.stringify(relayProfileFor(v["public-url"],secrets),null,2));return;
    }
    const port=Number(v.port??8788);if(!Number.isInteger(port)||port<1||port>65535)throw new Error("--port must be a TCP port number");
    const relay=createRelay({...secrets,hostname:v.listen??"127.0.0.1",port});
    const stop=()=>{relay.close();process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);
    console.log(JSON.stringify({event:"relay_listening",port:relay.server.port}));return;
  }
  const directory=resolve(v.state??join(homedir(),".local/share/herdr-remote"));
  const relayFile=join(directory,"relay.json");
  if(command==="relay") {
    const action=parsed.positionals[1];
    if(action==="join") {
      const source=parsed.positionals[2];if(!source)throw new Error("relay join requires the private relay profile file");
      const profile=readRelayProfile(source);privateDirectory(directory);
      writeFileSync(relayFile,JSON.stringify(profile,null,2)+"\n",{mode:0o600});chmodSync(relayFile,0o600);
      console.log(JSON.stringify({joined:true,relay:new URL(profile.host.url).host,next:"restart serve/up, then pair --scope control --qr"}));return;
    }
    if(action==="leave"){const present=existsSync(relayFile);if(present)unlinkSync(relayFile);console.log(JSON.stringify({left:present}));return;}
    if(action==="status"){console.log(JSON.stringify(existsSync(relayFile)?{joined:true,relay:new URL(readRelayProfile(relayFile).host.url).host}:{joined:false}));return;}
    throw new Error("relay needs join, leave, status, serve or profile");
  }
  if(command==="init") {
    if(!v.url)throw new Error("init requires --url https://hostname:port");
    const config=await initialize(directory,{url:v.url,listen:v.listen,port:v.port?Number(v.port):undefined,herdr:v.herdr,backend:v.backend as "herdr"|"orca"|"plain"|undefined,orcaConnection:v["orca-connection"],session:v.session,hostName:v.name,sans:v.san?.split(",")});
    const state=new State(directory,false);state.close();
    console.log(JSON.stringify({initialized:true,url:config.url,listen:config.listen,port:config.port,certificateSHA256:certificatePin(config.certificate)}));return;
  }
  let discover=false;
  if(command==="up") {
    if(!existsSync(join(directory,"config.json"))) {
      const port=Number(v.port??8443),host=localHostname(),addresses=lanAddresses();
      if(!Number.isInteger(port) || port<1 || port>65535)throw new Error("--port must be a TCP port number");
      const created=await initialize(directory,{url:`https://${host}:${port}`,listen:v.listen??"0.0.0.0",port,herdr:v.herdr,session:v.session,
        hostName:v.name??hostname().split(".")[0],sans:[...addresses,"localhost","127.0.0.1"],backend:v.backend as "herdr"|"orca"|"plain"|undefined,orcaConnection:v["orca-connection"],discoverable:true});
      new State(directory,false).close();
      console.error(`Created bridge state in ${directory}\n  address  ${created.url} (also ${addresses.join(", ")||"no LAN address found"})\n  pin      ${certificatePin(created.certificate)}`);
    }
    command="serve";discover=!v["no-discovery"];
  }
  const config=loadConfig(directory);
  if(command==="serve") {
    discover=discover || !!v.discoverable || (!!config.discoverable && !v["no-discovery"]);
    privateDirectory(directory);const lock=join(directory,"serve.lock"),lockValue=JSON.stringify({pid:process.pid,nonce:randomUUID()});
    if(existsSync(lock)) {
      let alive=true;
      try{const previous=JSON.parse(readFileSync(lock,"utf8")) as {pid:number};if(!Number.isInteger(previous.pid))throw new Error("Invalid process lock");try{process.kill(previous.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")alive=false;}}
      catch{throw new Error("Unrecognized server lock; inspect it locally before removing");}
      if(alive)throw new Error("A bridge already owns this state directory");unlinkSync(lock);
    }
    writeFileSync(lock,lockValue,{flag:"wx",mode:0o600});
    let shutdown:(()=>void)|undefined;
    const unlock=()=>{if(existsSync(lock)&&readFileSync(lock,"utf8")===lockValue)unlinkSync(lock);};
    try {
      const state=new State(directory,true),epoch=randomUUID();
      let backend:HostBackend|undefined;
      let notifications:ReturnType<typeof createNotifications>|undefined;
      let bridge:ReturnType<typeof createBridge>|undefined;
      let closed=false;
      shutdown=()=>{if(closed)return;closed=true;notifications?.close();if(bridge)bridge.close();else backend?.close();state.close();unlock();};
      // Only the chosen backend runs: plain terminals are never started for a Herdr or Orca bridge.
      const kind=v.backend??config.backend??"herdr";
      backend=kind==="orca"?createOrcaBackend({connectionFile:v["orca-connection"]??config.orcaConnection,epoch})
        :kind==="plain"?createPlainBackend({stateDir:directory,epoch,folders:v.folder?.map(f=>resolve(f))})
        :createHerdrBackend({herdr:v.herdr??config.herdr,session:v.session??config.session,epoch});
      notifications=createNotifications({state,backend,session:v.session??config.session});
      const pin=certificatePin(config.certificate),herdr=v.herdr??config.herdr;
      bridge=createBridge({route:notifications.route,state,backend,epoch,hostName:config.hostName,hostname:v.listen??config.listen,port:v.port?Number(v.port):config.port,tls:{cert:Bun.file(config.certificate),key:Bun.file(config.key)},
        ...(discover?{nearby:{scope:config.nearbyScope??"control",announce:request=>announce(herdr,pin,request)}}:{})});
      const listen=v.listen??config.listen,local=["0.0.0.0","::",""].includes(listen)?"127.0.0.1":listen;
      const relay=existsSync(relayFile)?connectRelay({profile:readRelayProfile(relayFile),target:{host:local,port:bridge.server.port??config.port},log:event=>console.error(JSON.stringify(event))}):undefined;
      const advertisement=discover?advertise({url:config.url,hostId:state.hostId,certificateSHA256:pin,name:config.hostName,port:bridge.server.port??config.port,pairing:true},message=>console.error(message)):undefined;
      const closeBridge=shutdown;shutdown=()=>{relay?.close();advertisement?.close();closeBridge();};
      process.once("SIGINT",()=>{shutdown?.();process.exit(0);});process.once("SIGTERM",()=>{shutdown?.();process.exit(0);});
      process.once("exit",()=>{shutdown?.();unlock();});
      console.log(JSON.stringify({event:"listening",url:config.url,hostId:state.hostId,protocolVersion:1,discoverable:discover,relay:!!relay}));
      if(discover && process.stderr.isTTY)console.error(`\nReady. Open AI Agent Remote on your phone on the same Wi-Fi: ${config.hostName} appears under Nearby.\nWhen you tap Pair, a 6-digit code pops up on this computer. Press Ctrl-C to stop.`);
    }catch(error){shutdown?.();unlock();throw error;}
    return;
  }
  const state=new State(directory,false);
  try {
    if(command==="pair") {
      const scope=v.scope??"read";if(scope!=="read"&&scope!=="control")throw new Error("--scope must be read or control");
      let connection;
      if(v.connection) {
        const file=lstatSync(v.connection);
        if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0||file.size>8192)throw new Error("Connection profile must be a private regular file");
        connection=connectionProfile(JSON.parse(readFileSync(v.connection,"utf8")),config.url);
      } else if(!v["no-relay"]&&existsSync(relayFile))connection=connectionProfile(readRelayProfile(relayFile).phone,config.url);
      const invitation={version:connection?2:1,url:config.url,certificateSHA256:certificatePin(config.certificate),...state.invite(scope,Number(v.ttl??300)),...(connection?{connection}:{})};
      const uri=`herdr-remote://pair?data=${Buffer.from(JSON.stringify(invitation)).toString("base64url")}`;
      console.log(v.json?JSON.stringify(invitation):uri);
      if(v.qr)console.log(await QRCode.toString(uri,{type:"terminal",small:true,errorCorrectionLevel:"M"}));
    } else if(command==="devices")console.log(JSON.stringify(state.devices(),null,2));
    else if(command==="revoke") {if(!v.device)throw new Error("revoke requires --device UUID");console.log(JSON.stringify({revoked:state.revoke(v.device),deviceId:v.device}));}
    else throw new Error("Unknown command. Use --help.");
  }finally{state.close();}
}
/** Show a nearby pairing code where the owner is: Herdr, the desktop and an interactive terminal. */
function announce(herdr:string,pin:string,request:{name:string;code:string}) {
  const name=request.name.replace(/[\p{C}]/gu," ").trim().slice(0,60)||"A phone";
  // Leading text keeps an attacker-chosen name from being parsed as a command-line option.
  const title=`Pairing request: ${name}`,body=`Code ${request.code.slice(0,3)} ${request.code.slice(3)} · fingerprint ${pin.slice(0,4)}-${pin.slice(4,8)}`;
  const quiet=(command:string,args:string[])=>{try{spawn(command,args,{stdio:"ignore",detached:false}).on("error",()=>{});}catch{}};
  quiet(herdr,["notification","show",title,"--body",body,"--sound","request"]);
  // Owner-local automation: a private file instead of desktop popups (used by disposable QA hosts).
  const codeFile=process.env.HERDR_REMOTE_PAIRING_CODE_FILE;
  if(codeFile){try{writeFileSync(codeFile,request.code+"\n",{mode:0o600});chmodSync(codeFile,0o600);}catch{}}
  if(process.env.HERDR_REMOTE_DESKTOP_NOTIFY!=="0") {
    if(process.platform==="darwin")quiet("osascript",["-e",`display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
    else if(Bun.which("notify-send"))quiet("notify-send",["-u","critical","-a","AI Agent Remote",title,body]);
  }
  if(process.stderr.isTTY)console.error(`\n${title}\n  ${body}\n  Type this code on the phone. It expires in 2 minutes.\n`);
}
if(import.meta.main) main().catch(error=>{
  // Our own errors describe the problem without secrets; keep anything else generic.
  const message=error instanceof Error && !/token|secret|BEGIN /i.test(error.message)?error.message:"unexpected failure";
  console.error(`Herdr Remote could not complete this command: ${message}\nUse --help for usage.`);process.exitCode=1;
});
