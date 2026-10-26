import {test,expect} from 'bun:test';
import {createOrcaBackend} from '../src/backend/orca';
import {OrcaClient} from '../src/backend/orca/client';
import {loadOrcaConnection} from '../src/backend/orca/connection';
/** Run only inside the task-owned runner with /workspace as a harmless Git fixture. */
test.skipIf(process.env.ORCA_REAL_TEST!=='1')('isolated real Orca pinned v2 stream, leases, shell, identity, files/Git and lifecycle',async()=>{
 expect(process.env.ORCA_TEST_ISOLATED).toBe('1');const path=process.env.ORCA_TEST_CONNECTION!;const connection=loadOrcaConnection(path);
 const b=createOrcaBackend({connectionFile:path,epoch:'disposable-orca'});const handles:Array<{close():void}>=[];
 try {
  await b.mutate('workspace.create',undefined,{cwd:'/workspace',label:'Disposable Orca fixture'});
  let s:any=await b.snapshot();expect(s.backend.kind).toBe('orca');expect(s.capabilities.agentStart).toBe(false);
  expect((await Promise.all([b.snapshot(),b.snapshot(),b.snapshot()])).length).toBe(3);
  if(!s.shellPanes.length){await b.mutate('tab.create',undefined,{workspaceId:s.workspaces[0].workspaceId,label:'Fixture shell'});s=await b.snapshot();}
  const p=s.shellPanes[0],frames:any[]=[];
  const observer=await b.terminal({paneId:p.paneId,control:false,takeover:false,cols:80,rows:24,onFrame:f=>frames.push(f),onClose:()=>{}});handles.push(observer);expect(frames[0].full).toBe(true);
  await expect(observer.command({type:'terminal.input',text:'FORBIDDEN'})).rejects.toMatchObject({status:403});
  await expect(b.submitText(undefined,p.paneId,'FORBIDDEN',true)).rejects.toMatchObject({status:403});
  await expect(b.terminal({paneId:p.paneId,expectedIdentityToken:'stale',control:true,takeover:false,cols:80,rows:24,onFrame:()=>{},onClose:()=>{}})).rejects.toMatchObject({status:409});
  const c=await b.terminal({paneId:p.paneId,expectedIdentityToken:p.identityToken,control:true,takeover:false,cols:80,rows:24,onFrame:()=>{},onClose:()=>{}});handles.push(c);
  await expect(b.terminal({paneId:p.paneId,control:true,takeover:false,cols:80,rows:24,onFrame:()=>{},onClose:()=>{}})).rejects.toMatchObject({status:409});
  observer.close(); // Closing a read-only stream must not discard the controller's input binding.
  const marker='ORCA_REAL_'+crypto.randomUUID().replaceAll('-','');await b.submitText(undefined,p.paneId,`printf '${marker}\\n'`,true,p.identityToken);
  let executed=false;for(let i=0;i<60;i++){const r=await b.output(undefined,p.paneId,80);if(String(r.text).split('\n').some(x=>x.trim()===marker)){executed=true;break;}await Bun.sleep(50);}expect(executed).toBe(true);
  expect((await b.identity(undefined,p.paneId)).identityToken).toBe(p.identityToken);
  expect((await b.file(undefined,p.workspaceId,'README.txt',p.paneId)).content).toContain('Disposable host fixture');expect((await b.git(undefined,p.workspaceId,p.paneId)).isRepo).toBe(true);
  expect((await b.transcript(undefined,p.paneId)).supported).toBe(false);
  await expect(b.file(undefined,p.workspaceId,'../outside',p.paneId)).rejects.toBeDefined();
  await expect(b.mutate('agent.start',undefined,{paneId:p.paneId,identityToken:p.identityToken,kind:'codex',name:'never-start'})).rejects.toMatchObject({status:501});
  await c.command({type:'terminal.resize',cols:90,rows:30});c.close();await expect(b.submitText(undefined,p.paneId,'FORBIDDEN',true)).rejects.toMatchObject({status:403});
  const tab:any=await b.mutate('tab.create',undefined,{workspaceId:p.workspaceId,label:'Disposable close test'});const made=tab.terminal.handle;
  const fresh=await b.identity(undefined,made);await b.mutate('pane.split',undefined,{paneId:made,identityToken:fresh.identityToken,direction:'right'});
  await b.mutate('pane.close',undefined,{paneId:made,identityToken:fresh.identityToken});await expect(b.identity(undefined,made)).rejects.toMatchObject({status:404});
  const invalid=new OrcaClient({...connection,publicKeyB64:Buffer.alloc(32,4).toString('base64')});await expect(invalid.call('status.get')).rejects.toBeDefined();invalid.close();
  const revoked=new OrcaClient({...connection,deviceToken:'z'.repeat(43)});await expect(revoked.call('status.get')).rejects.toBeDefined();revoked.close();
 } finally {for(const h of handles)h.close();b.close();}
},60000);
