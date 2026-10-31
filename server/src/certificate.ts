// Certificate renewal that keeps pairings. Phones pin the exact leaf, so a new certificate is announced
// ahead of time: the current key signs a statement naming the successor's pin, phones fetch it over the
// pinned connection and accept either pin until the bridge switches. A phone that never connects during
// that window pairs again, exactly as before.
import { X509Certificate, createPrivateKey, sign } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { certificatePin, type Config } from "./config";
import type { CertificateStatus } from "./app";

const DAY=86_400_000,RENEW_BEFORE=30*DAY,LIFETIME_DAYS=730;
interface Pending {statement:string;signature:string;switchAt:string;pin:string}
const paths=(config:Config)=>{const directory=dirname(config.certificate);return {certificate:join(directory,"certificate-next.pem"),key:join(directory,"private-key-next.pem"),pending:join(directory,"certificate-next.json")};};
function pending(config:Config):Pending|undefined {
  const p=paths(config);if(!existsSync(p.pending)||!existsSync(p.certificate)||!existsSync(p.key))return;
  try{return JSON.parse(readFileSync(p.pending,"utf8")) as Pending;}catch{return;}
}
export function certificateStatus(config:Config,hostId:string):CertificateStatus {
  const current=new X509Certificate(readFileSync(config.certificate)),next=pending(config);
  return {pin:certificatePin(config.certificate),expiresAt:new Date(current.validTo).toISOString(),
    ...(next?{next:{pin:next.pin,switchAt:next.switchAt,statement:next.statement,signature:next.signature,previousCertificate:current.raw.toString("base64")}}:{})};
}
/** Subject alternative names of the current certificate, so the successor answers to the same names. */
function names(certificate:X509Certificate):string[] {
  return (certificate.subjectAltName??"").split(",").map(part=>part.trim()).map(part=>part.replace(/^(DNS|IP Address):/,"")).filter(Boolean);
}
export async function renewCertificate(config:Config,hostId:string,switchAt?:Date):Promise<CertificateStatus> {
  const p=paths(config),current=new X509Certificate(readFileSync(config.certificate));
  for(const path of [p.certificate,p.key,p.pending])if(existsSync(path))unlinkSync(path);
  const san=names(current).map(name=>`${/^[0-9.]+$|:/.test(name)?"IP":"DNS"}:${name}`).join(",");
  const child=Bun.spawn(["openssl","req","-x509","-newkey","rsa:3072","-sha256","-nodes","-days",String(LIFETIME_DAYS),"-subj","/CN=Herdr Remote","-addext",`subjectAltName=${san}`,"-addext","extendedKeyUsage=serverAuth","-keyout",p.key,"-out",p.certificate],{stdout:"ignore",stderr:"pipe"});
  if(await child.exited!==0)throw new Error("OpenSSL failed to create the successor certificate");
  chmodSync(p.key,0o600);chmodSync(p.certificate,0o600);
  // Switch a day before the old one expires at the latest, so a running bridge never serves an expired leaf.
  const latest=new Date(new Date(current.validTo).getTime()-DAY),at=switchAt&&switchAt<latest?switchAt:latest;
  const nextPin=certificatePin(p.certificate);
  const statement=JSON.stringify({version:1,hostId,previous:certificatePin(config.certificate),next:nextPin,issuedAt:new Date().toISOString(),switchAt:at.toISOString()});
  const signature=sign("sha256",Buffer.from(statement),createPrivateKey(readFileSync(config.key))).toString("base64");
  writeFileSync(p.pending,JSON.stringify({statement,signature,switchAt:at.toISOString(),pin:nextPin})+"\n",{mode:0o600});
  return certificateStatus(config,hostId);
}
/** Renews automatically within 30 days of expiry. Returns true when the successor should now be served. */
export async function maintainCertificate(config:Config,hostId:string,log:(message:string)=>void=()=>{}):Promise<boolean> {
  const current=new X509Certificate(readFileSync(config.certificate)),next=pending(config);
  if(!next && new Date(current.validTo).getTime()-Date.now()<RENEW_BEFORE) {
    await renewCertificate(config,hostId);log("The bridge certificate expires soon: a successor was created and paired phones will move to it automatically when they connect.");return false;
  }
  return !!next && Date.parse(next.switchAt)<=Date.now();
}
/** Promote the successor. The previous files are kept beside it as `*-previous.pem`. */
export function switchCertificate(config:Config) {
  const p=paths(config);if(!pending(config))return false;
  const directory=dirname(config.certificate);
  renameSync(config.certificate,join(directory,"certificate-previous.pem"));renameSync(config.key,join(directory,"private-key-previous.pem"));
  renameSync(p.certificate,config.certificate);renameSync(p.key,config.key);unlinkSync(p.pending);
  return true;
}
