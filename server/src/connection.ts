import {isIP} from "node:net";
export interface GatewayConnection {url:string;token:string;certificateSHA256?:string;basicUsername?:string;basicPassword?:string;accessClientID?:string;accessClientSecret?:string;}
export type HostConnection={mode:"gateway";gateway:GatewayConnection}|{mode:"wireguard";wireGuardJSON:string};
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid connection profile");return value as Record<string,unknown>;}
function only(value:Record<string,unknown>,names:string[]){if(Object.keys(value).some(k=>!names.includes(k)))throw new Error("Unknown connection setting");}
export function connectionProfile(value:unknown,target:string):HostConnection {
 const profile=object(value),url=new URL(target);
 if(profile.mode==="gateway") {
  only(profile,["mode","gateway"]);const gateway=object(profile.gateway);only(gateway,["url","token","certificateSHA256","basicUsername","basicPassword","accessClientID","accessClientSecret"]);
  if(typeof gateway.url!=="string"||typeof gateway.token!=="string"||!/^[!-~]{32,512}$/.test(gateway.token))throw new Error("Invalid gateway credentials");
  const route=new URL(gateway.url);if(route.protocol!=="wss:"||route.username||route.password||route.pathname!=="/v1/tunnel"||route.search||route.hash)throw new Error("Gateway requires a root WSS tunnel endpoint");
  if(gateway.certificateSHA256!==undefined&&(typeof gateway.certificateSHA256!=="string"||!/^[a-f0-9]{64}$/.test(gateway.certificateSHA256)))throw new Error("Invalid gateway pin");
  for(const pair of [["basicUsername","basicPassword"],["accessClientID","accessClientSecret"]]) {
   if((gateway[pair[0]!]===undefined)!==(gateway[pair[1]!]===undefined))throw new Error("Incomplete gateway credentials");
   for(const name of pair){const text=gateway[name];if(text!==undefined&&(typeof text!=="string"||Buffer.byteLength(text)<1||Buffer.byteLength(text)>512||/[\r\n\0]/.test(text)))throw new Error("Invalid gateway credentials");}
  }
  if((gateway.basicUsername as string|undefined)?.includes(":"))throw new Error("Invalid gateway username");
  return {mode:"gateway",gateway:gateway as unknown as GatewayConnection};
 }
 if(profile.mode==="wireguard") {
  only(profile,["mode","wireGuardJSON"]);
  if(typeof profile.wireGuardJSON!=="string"||Buffer.byteLength(profile.wireGuardJSON)>8192)throw new Error("Invalid WireGuard profile");
  const fields=object(JSON.parse(profile.wireGuardJSON));
  if(fields.version!==1||typeof fields.runnerAddress!=="string"||!isIP(fields.runnerAddress)||fields.runnerAddress!==url.hostname.replace(/^\[|\]$/g,"")||fields.runnerPort!==Number(url.port||443))throw new Error("WireGuard route must match the pinned runner");
  return {mode:"wireguard",wireGuardJSON:profile.wireGuardJSON};
 }
 throw new Error("Unsupported connection mode");
}
