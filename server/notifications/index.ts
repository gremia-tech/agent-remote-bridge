import { connect } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import type { State, Device } from "../src/state";
import type { HostBackend } from "../src/backend/types";
import { BridgeError } from "../src/errors";

export interface APNSConfiguration { key: string; keyId: string; teamId: string; topic: string; }
interface Registration { device: string; token: string; environment: "sandbox"|"production"; }
export type PushSender = (registration: Registration, payload: object) => Promise<number>;
export function configurationFromEnvironment(): APNSConfiguration | undefined {
  const {HMR_APNS_KEY_FILE:file,HMR_APNS_KEY_ID:keyId,HMR_APNS_TEAM_ID:teamId,HMR_APNS_TOPIC:topic}=process.env;
  if(!file && !keyId && !teamId && !topic)return;
  if(!file || !keyId || !teamId || !topic)throw new Error("All HMR_APNS settings are required");
  const stat=lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)!==0)throw new Error("APNs key must be a private regular file (0600)");
  if(!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Za-z0-9.-]{1,200}$/.test(topic))throw new Error("Invalid APNs configuration");
  return {key:readFileSync(file,"utf8"),keyId,teamId,topic};
}
export function createProvider(configuration: APNSConfiguration): PushSender {
  const key=createPrivateKey(configuration.key);
  if(key.asymmetricKeyType!=="ec" || key.asymmetricKeyDetails?.namedCurve!=="prime256v1")throw new Error("APNs requires a P-256 signing key");
  let cached="",issued=0;
  function jwt() {
    const now=Math.floor(Date.now()/1000);
    if(cached && now-issued<2400)return cached;
    const header=Buffer.from(JSON.stringify({alg:"ES256",kid:configuration.keyId})).toString("base64url");
    const claims=Buffer.from(JSON.stringify({iss:configuration.teamId,iat:now})).toString("base64url");
    const value=`${header}.${claims}`;
    issued=now;cached=`${value}.${sign("sha256",Buffer.from(value),{key,dsaEncoding:"ieee-p1363"}).toString("base64url")}`;return cached;
  }
  return (registration,payload)=>new Promise((resolve,reject)=>{
    const authority=registration.environment==="sandbox"?"https://api.sandbox.push.apple.com":"https://api.push.apple.com";
    const client=connect(authority);let finished=false;
    const finish=(status?:number,error?:Error)=>{if(finished)return;finished=true;clearTimeout(timeout);client.destroy();error?reject(error):resolve(status??503);};
    const timeout=setTimeout(()=>finish(undefined,new Error("Push delivery timed out")),10_000);
    client.on("error",()=>finish(undefined,new Error("Push connection failed")));
    const request=client.request({":method":"POST",":path":`/3/device/${registration.token}`,"authorization":`bearer ${jwt()}`,"apns-topic":configuration.topic,"apns-push-type":"alert","apns-priority":"10","apns-expiration":"0","apns-collapse-id":"herdr-attention","content-type":"application/json"});
    let status=503,total=0;
    request.on("response",headers=>{status=Number(headers[":status"]??503);});
    request.on("data",chunk=>{total+=chunk.length;if(total>8192)finish(undefined,new Error("Push response too large"));});
    request.on("error",()=>finish(undefined,new Error("Push request failed")));
    request.on("end",()=>finish(status));request.end(JSON.stringify(payload));
  });
}
export function genericPayload(hostId: string) {
  return {aps:{alert:{title:"Herdr needs your attention",body:"Open Herdr Remote to check your agents."},sound:"default"},hostId};
}
export function createNotifications(options:{state:State;backend:HostBackend;configuration?:APNSConfiguration;sender?:PushSender;pollMilliseconds?:number;session?:string}) {
  const {state,backend}=options,configuration=options.configuration??configurationFromEnvironment();
  const sender=options.sender??(configuration?createProvider(configuration):undefined);
  state.db.exec("CREATE TABLE IF NOT EXISTS notification_devices (device TEXT PRIMARY KEY,token TEXT NOT NULL,environment TEXT NOT NULL)");
  let stopped=false,busy=false,seeded=false;let previous=new Map<string,string>();const notified=new Map<string,number>();
  async function poll() {
    if(stopped || busy || !sender)return;busy=true;
    try {
      const snapshot=await backend.snapshot(options.session);
      if(stopped)return;
      const agents=Array.isArray(snapshot.agents)?snapshot.agents as Record<string,unknown>[]:[];
      const next=new Map<string,string>();let changed=false;
      for(const pane of agents) {
        const identity=String(pane.identityToken??pane.paneId),status=String(pane.status);
        next.set(identity,status);
        if(seeded && previous.get(identity)!==status && ["blocked","done","error"].includes(status) && Date.now()-(notified.get(identity)??0)>60_000){changed=true;notified.set(identity,Date.now());}
      }
      previous=next;seeded=true;
      for(const id of notified.keys())if(!next.has(id))notified.delete(id);
      if(!changed)return;
      const registrations=state.db.query("SELECT device,token,environment FROM notification_devices").all() as Registration[];
      for(const registration of registrations) {
        if(stopped)return;
        if(!state.active(registration.device)){state.db.query("DELETE FROM notification_devices WHERE device=?").run(registration.device);continue;}
        try {const status=await sender(registration,genericPayload(state.hostId));if(status===410 || status===400)state.db.query("DELETE FROM notification_devices WHERE device=?").run(registration.device);}catch{ /* Retry only on a later status transition; never log credentials or payloads. */ }
      }
    } catch { /* Host can be offline. Never alert about an unverified state. */ } finally {busy=false;}
  }
  const timer=sender?setInterval(()=>{void poll();},options.pollMilliseconds??10_000):undefined;timer?.unref();
  if(sender)void poll();
  return {
    enabled:!!sender,
    poll,
    async route(request:Request,url:URL,device:Device):Promise<Response|undefined> {
      if(url.pathname!=="/v1/notifications")return;
      if(request.method==="DELETE"){state.db.query("DELETE FROM notification_devices WHERE device=?").run(device.id);return Response.json({enabled:false});}
      if(request.method!=="POST")throw new BridgeError("not_found","Unknown route",404);
      if(!sender)throw new BridgeError("notifications_unavailable","This host has no notification provider configured",501);
      if(!request.headers.get("content-type")?.startsWith("application/json"))throw new BridgeError("invalid_request","JSON required");
      const reader=request.body?.getReader();if(!reader)throw new BridgeError("invalid_request","Body required");
      const chunks:Uint8Array[]=[];let size=0;
      while(true){const result=await reader.read();if(result.done)break;size+=result.value.length;if(size>1024){await reader.cancel();throw new BridgeError("request_too_large","Body limit",413);}chunks.push(result.value);}
      let value:Record<string,unknown>;try{value=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new BridgeError("invalid_request","Malformed JSON");}
      if(!value || Array.isArray(value) || Object.keys(value).some(key=>!["token","environment"].includes(key)) || typeof value.token!=="string" || !/^[a-f0-9]{32,256}$/.test(value.token) || !["sandbox","production"].includes(String(value.environment)))throw new BridgeError("invalid_request","Invalid notification registration");
      state.db.query("INSERT INTO notification_devices VALUES (?,?,?) ON CONFLICT(device) DO UPDATE SET token=excluded.token,environment=excluded.environment").run(device.id,value.token,String(value.environment));
      return Response.json({enabled:true});
    },
    close(){stopped=true;if(timer)clearInterval(timer);}
  };
}
