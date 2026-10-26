import { randomUUID } from 'node:crypto';
import { createPairedE2EEClientHandshake } from '../../../vendor/orca/paired-e2ee-client-handshake';
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../vendor/orca/paired-e2ee-node-primitives';
import { BackendError } from '../types';
import type { OrcaConnection } from './connection';
const MAX=2*1024*1024;
type Pending={method:string;resolve:(value:any)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>;stream?:boolean;write:boolean};
/** One pinned v2 channel. No plaintext/legacy downgrade, redirects, credentials in URLs or replay. */
export class OrcaClient {
  private ws?:WebSocket;private pending=new Map<string,Pending>();private stream?:{id:string;receive:(value:any)=>void};
  private closed=false;private authenticated=false;private runtimeId?:string;private readiness?:Promise<void>;
  private handshake:ReturnType<typeof createPairedE2EEClientHandshake>;
  constructor(private connection:OrcaConnection,private ended:()=>void=()=>{}){this.handshake=createPairedE2EEClientHandshake({primitives:NODE_PAIRED_E2EE_PRIMITIVES,hostPublicKeyB64:connection.publicKeyB64,framing:'v2',transport:'direct'});}
  open():Promise<void> {
    if(this.closed)return Promise.reject(new BackendError('orca_closed','Orca channel is closed'));
    if(this.readiness)return this.readiness;
    this.readiness=new Promise<void>((resolve,reject)=>{
      let phase='ready';const timer=setTimeout(()=>fail(),8000);
      const fail=()=>{clearTimeout(timer);reject(new BackendError('orca_unavailable','Cannot authenticate the pinned local Orca runtime'));this.close();};
      const ws=this.ws=new WebSocket(this.connection.endpoint);
      ws.onopen=()=>ws.send(this.handshake.helloText());
      ws.onerror=fail;ws.onclose=()=>{if(!this.authenticated)fail();else this.close();};
      ws.onmessage=event=>{try {
        if(typeof event.data!=='string'||event.data.length>MAX*2)throw 0;
        if(phase==='ready') {if(this.handshake.acceptReadyText(event.data)!=='accepted')throw 0;phase='auth';void this.handshake.sealAuth({kind:'token',deviceToken:this.connection.deviceToken}).then(value=>{if(!this.closed)ws.send(value);},fail);return;}
        const plain=this.handshake.channel.openText(event.data);if(plain===null||Buffer.byteLength(plain)>MAX)throw 0;
        if(phase==='auth') {if(this.handshake.classifyAuthReply(plain).kind!=='authenticated')throw 0;phase='rpc';this.authenticated=true;clearTimeout(timer);resolve();return;}
        const frame=JSON.parse(plain);if(!frame||typeof frame.id!=='string'||typeof frame.ok!=='boolean'||typeof frame._meta?.runtimeId!=='string')throw 0;
        if(this.runtimeId&&this.runtimeId!==frame._meta.runtimeId)throw 0;this.runtimeId=frame._meta.runtimeId;
        const pending=this.pending.get(frame.id);
        const stream=this.stream;if(stream&&stream.id===frame.id){if(!frame.ok)throw 0;if(frame.streaming===true){stream.receive(frame.result);return;}}
        if(!pending)return;
        this.pending.delete(frame.id);clearTimeout(pending.timer);
        if(!frame.ok){pending.reject(new BackendError('orca_rejected','Orca refused '+pending.method+' ('+String(frame.error?.code??'unknown').replace(/[^a-z_]/g,'').slice(0,48)+')',frame.error?.code==='method_not_found'?501:409,pending.write));return;}
        pending.resolve(frame.result);
      }catch{fail();}};
    });return this.readiness;
  }
  async call(method:string,params:Record<string,unknown>={},write=false):Promise<any> {
    await this.open();if(this.closed)throw new BackendError('orca_closed','Orca channel is closed');
    if(this.pending.size>=32)throw new BackendError('orca_busy','Orca request queue is full',429);
    const id=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new BackendError('orca_timeout','Orca did not acknowledge this operation',503,write));this.close();},10000);
      this.pending.set(id,{method,resolve,reject,timer,write});
      try{this.send({id,method,params});}catch{this.pending.delete(id);clearTimeout(timer);reject(new BackendError('orca_write','Orca request could not be sent',503,write));this.close();}
    });
  }
  async subscribe(params:Record<string,unknown>,receive:(value:any)=>void) {
    await this.open();if(this.stream||this.closed)throw new BackendError('orca_closed','Orca stream is unavailable');
    const id=randomUUID();this.stream={id,receive};this.send({id,method:'terminal.subscribe',params});
  }
  private send(value:unknown) {const text=JSON.stringify(value);if(Buffer.byteLength(text)>65536||!this.ws||this.ws.readyState!==WebSocket.OPEN||this.ws.bufferedAmount>65536)throw new BackendError('orca_backpressure','Orca input queue is full',429);this.ws.send(this.handshake.channel.sealText(text));}
  close() {if(this.closed)return;this.closed=true;this.ws?.close();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new BackendError('orca_closed','Orca channel closed',503,p.write));}this.pending.clear();this.ended();}
}
