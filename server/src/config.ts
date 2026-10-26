import { chmodSync, existsSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { privateDirectory } from "./state";
export interface Config {version:1;hostName:string;url:string;listen:string;port:number;herdr:string;backend?:'herdr'|'orca'|'plain';orcaConnection?:string;session?:string;certificate:string;key:string;
  /** Advertise on the local network (Bonjour) and allow code-confirmed nearby pairing. */
  discoverable?:boolean;nearbyScope?:'read'|'control';}
export function endpoint(value:string):URL {
  const url=new URL(value);
  if(url.protocol!=="https:" || url.username || url.password || url.search || url.hash || !["","/"].includes(url.pathname))throw new Error("Endpoint must be a root HTTPS URL without credentials, query, or fragment");
  return url;
}
export function loadConfig(directory:string):Config {
  const path=join(directory,"config.json");
  if(!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())throw new Error("Config must be a regular file");
  chmodSync(path,0o600);
  const config=JSON.parse(readFileSync(path,"utf8")) as Config;
  if(config.version!==1 || !config.url || !config.certificate || !config.key || !Number.isInteger(config.port) || config.port<1 || config.port>65535)throw new Error("Invalid bridge config");
  endpoint(config.url);
  if(config.backend!==undefined&&!['herdr','orca','plain'].includes(config.backend))throw new Error("Unknown backend");
  if(config.backend==="orca"&&typeof config.orcaConnection!=="string")throw new Error("Orca backend requires a private connection file");
  const key=lstatSync(config.key);if(!key.isFile() || key.isSymbolicLink() || (key.mode&0o077)!==0)throw new Error("TLS private key must be a private regular file (0600)");
  return config;
}
export function certificatePin(path:string) {return new X509Certificate(readFileSync(path)).fingerprint256.replaceAll(":","").toLowerCase();}
export async function initialize(directory:string,options:{url:string;listen?:string;port?:number;herdr?:string;session?:string;hostName?:string;sans?:string[];backend?:'herdr'|'orca'|'plain';orcaConnection?:string;discoverable?:boolean}) {
  directory=resolve(directory);privateDirectory(directory);
  if(existsSync(join(directory,"config.json")))throw new Error("Already initialized; existing keys and devices were preserved");
  if(options.backend&&!["herdr","orca","plain"].includes(options.backend)||options.backend==="orca"&&!options.orcaConnection)throw new Error("Invalid backend configuration");
  const url=endpoint(options.url),cert=join(directory,"certificate.pem"),key=join(directory,"private-key.pem");
  if(existsSync(cert)||existsSync(key))throw new Error("Existing TLS material found; preserve it or use another state directory");
  const names=[url.hostname.replace(/^\[|\]$/g,""),...(options.sans??[])];
  if(names.some(name=>!isIP(name) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(name)))throw new Error("Invalid certificate hostname/IP");
  const san=[...new Set(names)].map(name=>`${isIP(name)?"IP":"DNS"}:${name}`).join(",");
  const child=Bun.spawn(["openssl","req","-x509","-newkey","rsa:3072","-sha256","-nodes","-days","365","-subj","/CN=Herdr Remote","-addext",`subjectAltName=${san}`,"-addext","extendedKeyUsage=serverAuth","-keyout",key,"-out",cert],{stdout:"ignore",stderr:"pipe"});
  if(await child.exited!==0)throw new Error("OpenSSL failed to create TLS material");
  chmodSync(key,0o600);chmodSync(cert,0o600);
  const config:Config={version:1,hostName:options.hostName??hostname(),url:url.origin,listen:options.listen??"127.0.0.1",port:options.port??Number(url.port||443),herdr:options.herdr??"herdr",...(options.backend?{backend:options.backend}:{}),...(options.orcaConnection?{orcaConnection:resolve(options.orcaConnection)}:{}),...(options.session?{session:options.session}:{}),...(options.discoverable?{discoverable:true}:{}),certificate:cert,key};
  writeFileSync(join(directory,"config.json"),JSON.stringify(config,null,2)+"\n",{mode:0o600});
  return config;
}
