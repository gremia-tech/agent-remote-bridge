import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { BackendError } from '../types';
export interface OrcaConnection {endpoint:string;publicKeyB64:string;deviceToken:string;scope:'runtime'}
export function parseOrcaConnection(text:string,localEndpoint?:string):OrcaConnection {
  if(Buffer.byteLength(text)>16384)throw new BackendError('orca_config','Orca access file exceeds the limit',400);
  let value:any;
  try {
    text=text.trim();
    if(text.startsWith('orca://')) {const url=new URL(text);if(url.hostname!=='pair'||url.pathname&&url.pathname!=='/'||url.username||url.password)throw 0;const code=url.searchParams.get('code')??url.hash.slice(1);if(!/^[A-Za-z0-9_-]+$/.test(code))throw 0;text=Buffer.from(code,'base64url').toString('utf8');}
    value=JSON.parse(text);
    // Readiness JSON may wrap the exact native pairing URL; never persist its logs.
    if(typeof value.pairingUrl==='string'){if(value.localEndpoint!==undefined&&typeof value.localEndpoint!=='string')throw 0;return parseOrcaConnection(value.pairingUrl,localEndpoint??value.localEndpoint);}
    const original=new URL(value.endpoint);if(original.username||original.password||original.search||original.hash)throw 0;
    const u=new URL(localEndpoint??value.endpoint);
    if(!['ws:','wss:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname)||!['127.0.0.1','[::1]','localhost'].includes(u.hostname))throw 0;
    if(value.v!==undefined&&value.v!==2||value.scope!=='runtime'||value.relay||typeof value.deviceToken!=='string'||!/^[A-Za-z0-9_-]{32,512}$/.test(value.deviceToken)||typeof value.publicKeyB64!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value.publicKeyB64))throw 0;
    return {endpoint:u.href,publicKeyB64:value.publicKeyB64,deviceToken:value.deviceToken,scope:'runtime'};
  }catch{throw new BackendError('orca_config','Use a private runtime-scoped Orca access link for the local runtime (not a mobile/cloud offer)',400);}
}
export function loadOrcaConnection(path:string):OrcaConnection {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const s=fstatSync(fd);
    if(!s.isFile()||(s.mode&0o077)!==0||s.size>16384||typeof process.getuid==='function'&&s.uid!==process.getuid())throw new BackendError('orca_config','Orca access file must be a private owner-held regular file (0600)',400);
    const bytes=Buffer.alloc(16385);let used=0;
    while(used<bytes.length){const n=readSync(fd,bytes,used,bytes.length-used,null);if(!n)break;used+=n;}
    if(used>16384)throw new BackendError('orca_config','Orca access file exceeds the limit',400);
    return parseOrcaConnection(bytes.subarray(0,used).toString('utf8'));
  } finally {closeSync(fd);}
}
