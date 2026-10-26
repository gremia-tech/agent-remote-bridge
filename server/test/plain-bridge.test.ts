import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {State} from '../src/state';
import {createBridge} from '../src/app';
import {createPlainBackend} from '../src/backend/plain';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});

test('a paired phone drives a plain terminal through the bridge',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'plain-bridge-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const home=join(dir,'home'),project=join(dir,'project');mkdirSync(home);mkdirSync(project);writeFileSync(join(home,'.profile'),"PS1='$ '\n");
  const state=new State(dir,true),backend=createPlainBackend({stateDir:dir,shell:'/bin/sh',folders:[home],env:{PATH:'/usr/bin:/bin',HOME:home}});
  const bridge=createBridge({state,backend});cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
  const base=bridge.server.url.origin,token=state.pair(state.invite('control').code,'Phone').token;
  const call=async(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const snapshot=async()=>await (await call('/v1/snapshot')).json() as any;

  let s=await snapshot();expect(s.backend.kind).toBe('plain');expect(s.capabilities.liveInput).toBe(true);
  const created=await call('/v1/workspaces','POST',{requestId:crypto.randomUUID(),cwd:project,label:'Project'});expect(created.status).toBeLessThan(300);
  s=await snapshot();const pane=s.shellPanes.find((p:any)=>p.cwd===project);expect(pane).toBeTruthy();

  const lease=await (await call(`/v1/panes/${encodeURIComponent(pane.paneId)}/control`,'POST',{identityToken:pane.identityToken,takeover:false})).json() as any;
  expect(lease.leaseId).toBeTruthy();
  const ws=new WebSocket(base.replace(/^http/,'ws')+'/v1/live',{headers:{Authorization:`Bearer ${token}`}} as any);cleanup.push(()=>ws.close());
  const frames:any[]=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data as string);if(m.type==='pane_frame')frames.push(m);});
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  ws.send(JSON.stringify({type:'observe',paneId:pane.paneId,identityToken:pane.identityToken,leaseId:lease.leaseId,cols:80,rows:24}));
  const text=()=>frames.map(f=>Buffer.from(f.bytes,'base64').toString()).join('');
  const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('timed out: '+JSON.stringify(text().slice(-200)));await Bun.sleep(20);}};
  await until(()=>frames.some(f=>f.full));
  ws.send(JSON.stringify({type:'input',leaseId:lease.leaseId,bytes:Buffer.from("pwd; printf 'E2E_%s\\n' OK\r").toString('base64')}));
  await until(()=>text().includes('E2E_OK')&&text().includes(project));
  const out=await (await call(`/v1/panes/${encodeURIComponent(pane.paneId)}/output?lines=20`)).json() as any;expect(out.text).toContain('E2E_OK');
});
