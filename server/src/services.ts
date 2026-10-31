// One running bridge: state, backend, phone API, relay connection and Bonjour advertisement. The CLI starts
// it once; the console and certificate renewal stop and start it again in the same process.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { State } from "./state";
import { loadConfig, certificatePin, type Config } from "./config";
import { createBridge } from "./app";
import { createHerdrBackend, type HostBackend } from "./backend/index";
import { createOrcaBackend } from "./backend/orca";
import { createPlainBackend } from "./backend/plain";
import { createNotifications } from "../notifications/index";
import { advertise, lanAddresses } from "./discovery";
import { connectRelay, readRelayProfile } from "./relay";
import { certificateStatus } from "./certificate";

export interface ServiceFlags {backend?:string;folder?:string[];"orca-connection"?:string;herdr?:string;session?:string;listen?:string;port?:string;"no-discovery"?:boolean;"no-local-route"?:boolean;}
export interface Services {
  state:State;config:Config;bridge:ReturnType<typeof createBridge>;relay?:ReturnType<typeof connectRelay>;
  backend:"herdr"|"orca"|"plain";discoverable:boolean;localRoutes():string[];localRoute:boolean;listen:string;port:number;startedAt:string;close():void;
}
const loopback=(address:string)=>["127.0.0.1","localhost","::1"].includes(address);
export async function startServices(directory:string,v:ServiceFlags,discover:boolean):Promise<Services> {
  const config=loadConfig(directory),relayFile=join(directory,"relay.json"),profile=existsSync(relayFile)?readRelayProfile(relayFile):undefined;
  const state=new State(directory,true),epoch=randomUUID();
  let backend:HostBackend|undefined,notifications:ReturnType<typeof createNotifications>|undefined,bridge:ReturnType<typeof createBridge>|undefined;
  const closeAll=()=>{notifications?.close();if(bridge)bridge.close();else backend?.close();state.close();};
  try {
    // Only the chosen backend runs: plain terminals are never started for a Herdr or Orca bridge.
    const kind=(v.backend??config.backend??"herdr") as Services["backend"];
    backend=kind==="orca"?createOrcaBackend({connectionFile:v["orca-connection"]??config.orcaConnection,epoch})
      :kind==="plain"?createPlainBackend({stateDir:directory,epoch,folders:v.folder?.map(f=>resolve(f))})
      :createHerdrBackend({herdr:v.herdr??config.herdr,session:v.session??config.session,epoch});
    notifications=createNotifications({state,backend,session:v.session??config.session});
    const pin=certificatePin(config.certificate),herdr=v.herdr??config.herdr;
    // A relayed bridge also answers on this network, so a phone at home skips the internet round trip.
    const localRoute=!!profile && !v["no-local-route"] && config.localRoute!==false;
    let listen=v.listen??config.listen;if(localRoute&&loopback(listen))listen="0.0.0.0";
    const port=v.port?Number(v.port):config.port,wildcard=["0.0.0.0","::",""].includes(listen);
    const localRoutes=()=>loopback(listen)?[]:(wildcard?lanAddresses():[listen]).map(address=>`https://${address.includes(":")?`[${address}]`:address}:${bridge?.server.port??port}`);
    let relaySupportsCredentials=state.metadata("relayRevision")==="2";
    bridge=createBridge({route:notifications.route,state,backend,epoch,hostName:config.hostName,hostname:listen,port,tls:{cert:Bun.file(config.certificate),key:Bun.file(config.key)},
      ...(discover?{nearby:{scope:config.nearbyScope??"control",announce:request=>announce(herdr,pin,request)}}:{}),
      ...(profile?{relay:{gateway:profile.phone.gateway,credentials:()=>relaySupportsCredentials}}:{}),
      certificate:()=>certificateStatus(loadConfig(directory),state.hostId),
      ...(!loopback(listen)?{localRoutes:()=>localRoutes()}:{})});
    const relay=profile&&bridge.relayServer?connectRelay({profile,target:{host:"127.0.0.1",port:bridge.relayServer.port!},log:event=>console.error(JSON.stringify(event)),
      credentials:()=>state.relayDigests(),onHello:revision=>{relaySupportsCredentials=revision>=2;state.setMetadata("relayRevision",String(revision));}}):undefined;
    const advertisement=discover?advertise({url:config.url,hostId:state.hostId,certificateSHA256:pin,name:config.hostName,port:bridge.server.port??port,pairing:discover},message=>console.error(message)):undefined;
    console.log(JSON.stringify({event:"listening",url:config.url,hostId:state.hostId,protocolVersion:1,discoverable:discover,relay:!!relay,localRoute}));
    if(discover && process.stderr.isTTY)console.error(`\nReady. Open AI Agent Remote on your phone on the same Wi-Fi: ${config.hostName} appears under Nearby.\nWhen you tap Pair, a 6-digit code pops up on this computer. Press Ctrl-C to stop.`);
    const created=bridge;
    return {state,config,bridge:created,relay,backend:kind,discoverable:discover,localRoutes,localRoute,listen,port:created.server.port??port,startedAt:new Date().toISOString(),
      close(){relay?.close();advertisement?.close();closeAll();}};
  }catch(error){closeAll();throw error;}
}
/** Show a nearby pairing code where the owner is: Herdr, the desktop and an interactive terminal. */
export function announce(herdr:string,pin:string,request:{name:string;code:string}) {
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
