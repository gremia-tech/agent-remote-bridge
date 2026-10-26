import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {BackendError,type HostBackend,type PaneIdentity,type TerminalHandle} from '../types';
import {resolveWorkspaceRoot,listWorkspaceFiles,readWorkspaceFile,readWorkspaceGitStatus,readWorkspaceGitDiff,WorkspaceInspectionError} from '../workspace-inspection';
import {OrcaClient} from './client';
import {loadOrcaConnection,parseOrcaConnection,type OrcaConnection} from './connection';
export interface OrcaBackendOptions {connectionFile?:string;connection?:OrcaConnection;epoch?:string}
const workspaceLabel=(w:any)=>[w?.repo,w?.displayName||w?.branch].filter((x:unknown)=>typeof x==='string'&&x).join(' · ')||'Workspace';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(value:unknown,name:string,max=4096):string=>{if(typeof value!=='string'||!value||value.length>max||value.includes('\0'))throw new BackendError('invalid_argument',`Invalid ${name}`,400);return value;};
export function createOrcaBackend(options:OrcaBackendOptions):HostBackend {
  const connection=options.connection?parseOrcaConnection(JSON.stringify(options.connection)):loadOrcaConnection(text(options.connectionFile,'Orca connection file'));
  const epoch=options.epoch??randomUUID();let stopped=false;let api:OrcaClient|undefined;
  const handles=new Set<TerminalHandle>();const controllers=new Map<string,{send:(value:string,submit:boolean)=>Promise<unknown>;close:()=>void}>();
  const checkSession=(session?:string)=>{if(stopped)throw new BackendError('backend_closed','Backend is closed');if(session&&session!=='default')throw new BackendError('invalid_session','This bridge selects one explicit Orca runtime',400);};
  function client(){if(stopped)throw new BackendError('backend_closed','Backend is closed');return api??(api=new OrcaClient(connection,()=>{api=undefined;}));}
  let pendingCatalog:Promise<any>|undefined;
  function catalog(session?:string):Promise<any> {
    checkSession(session);if(pendingCatalog)return pendingCatalog;
    const run=readCatalog(session);pendingCatalog=run;void run.finally(()=>{if(pendingCatalog===run)pendingCatalog=undefined;}).catch(()=>{});return run;
  }
  async function readCatalog(session?:string) {
    checkSession(session);const rpc=client();const [status,worktrees]=await Promise.all([rpc.call('status.get'),rpc.call('worktree.ps',{limit:512})]);
    // Both listings refresh Orca's inventory generation; parallel refreshes invalidate one another.
    const listing=await rpc.call('terminal.list',{limit:512,includeVisualLayouts:false,requireFreshPtyLiveness:true});
    if(status.runtimeProtocolVersion!==3||typeof status.runtimeId!=='string'||!Array.isArray(listing.terminals)||!Array.isArray(worktrees.worktrees)||listing.terminals.length>512||worktrees.worktrees.length>512||listing.truncated||worktrees.truncated)throw new BackendError('orca_protocol','Orca protocol3 and a complete bounded catalog are required',501);
    const panes=listing.terminals.filter((p:any)=>!p.orphaned&&typeof p.handle==='string'&&typeof p.worktreeId==='string'&&typeof p.tabId==='string');
    return {status,panes,workspaces:worktrees.worktrees};
  }
  function identity(state:any,p:any):PaneIdentity {return {paneId:p.handle,identityToken:digest([epoch,state.status.runtimeId,p.handle,p.ptyId,p.incarnationId,p.worktreeId,p.tabId,p.leafId,p.agentIdentity??null]),revision:0,agent:typeof p.agentIdentity==='string'?p.agentIdentity:'shell',status:p.verdict==='live'?'unknown':'offline'};}
  async function pane(session:string|undefined,id:string,expected?:string) {text(id,'pane',256);const state=await catalog(session);const p=state.panes.find((p:any)=>p.handle===id);if(!p)throw new BackendError('pane_not_found','Pane is not present in the selected Orca runtime',404);const i=identity(state,p);if(expected&&i.identityToken!==expected)throw new BackendError('identity_changed','Orca pane identity changed',409);return {state,p,identity:i};}
  async function inspect<T>(session:string|undefined,workspaceId:string,paneId:string|undefined,fn:(root:string)=>Promise<T>):Promise<T> {
    const state=await catalog(session);const w=state.workspaces.find((w:any)=>w.worktreeId===workspaceId);const panes=state.panes.filter((p:any)=>p.worktreeId===workspaceId);
    if(!w)throw new BackendError('workspace_not_found','Orca workspace is not present',404);
    if(paneId&&!panes.some((p:any)=>p.handle===paneId))throw new BackendError('pane_not_found','Pane does not belong to this workspace',404);
    if(w.hostId&&w.hostId!=='local'||!panes.length||panes.some((p:any)=>p.executionHostId!=='local'))throw new BackendError('inspection_unavailable','Run the bridge on the execution host for file/Git inspection',501);
    try {return await fn(await resolveWorkspaceRoot(w.path,[w.path]));}catch(e){if(e instanceof WorkspaceInspectionError)throw new BackendError('inspection_unavailable',e.message,e.status===422?409:e.status);throw e;}
  }
  return {
    async snapshot(session) {
      const s=await catalog(session);const agents:any[]=[],shells:any[]=[];
      for(let offset=0;offset<s.panes.length;offset+=8){const batch=await Promise.all(s.panes.slice(offset,offset+8).map(async(p:any)=>{
        const w=s.workspaces.find((w:any)=>w.worktreeId===p.worktreeId);let status='unknown';
        if(p.agentIdentity){const r=await client().call('terminal.agentStatus',{terminal:p.handle});status=r.agentStatus?.status==='permission'?'blocked':r.agentStatus?.status??'unknown';}
        const row={...identity(s,p),workspaceId:p.worktreeId,workspaceLabel:workspaceLabel(w),workspaceNumber:s.workspaces.indexOf(w)+1,tabId:p.tabId,agent:p.agentIdentity??'shell',kind:p.agentIdentity?'agent':'shell',status,cwd:w?.path??p.worktreePath??'/',focused:false};
        return row;
      }));for(const row of batch)(row.kind==='agent'?agents:shells).push(row);}
      const tabs=[...new Map(s.panes.map((p:any)=>[p.tabId,{tabId:p.tabId,workspaceId:p.worktreeId,label:p.title??'',number:s.panes.filter((x:any)=>x.worktreeId===p.worktreeId).findIndex((x:any)=>x.tabId===p.tabId)+1,paneCount:s.panes.filter((x:any)=>x.tabId===p.tabId).length}])).values()];
      return {bridge:'connected',session:'default',epoch:digest([epoch,s.status.runtimeId]),backend:{kind:'orca',name:'Orca',version:s.status.appVersion??null,protocol:3,controlScope:'bridge',transcript:'terminal-output'},capabilities:{output:true,terminalObserve:true,terminalControl:true,transcript:false,git:true,files:true,submitText:true,atomicSubmit:true,workspaceCreate:true,tabCreate:true,paneSplit:true,paneClose:true,agentStart:false},agents,shellPanes:shells,workspaces:s.workspaces.map((w:any,index:number)=>({workspaceId:w.worktreeId,label:workspaceLabel(w),number:index+1,tabCount:tabs.filter((t:any)=>t.workspaceId===w.worktreeId).length,paneCount:s.panes.filter((p:any)=>p.worktreeId===w.worktreeId).length})),tabs,sessions:[{name:'default',isPrimary:true,reachable:true,agents:agents.length,working:agents.filter(p=>p.status==='working').length,blocked:agents.filter(p=>p.status==='blocked').length}],ts:Date.now()};
    },
    async identity(session,id){return (await pane(session,id)).identity;},
    async output(session,id,lines=240) {if(!Number.isInteger(lines)||lines<1||lines>2000)throw new BackendError('invalid_lines','Invalid output line count',400);const before=await pane(session,id);const r=await client().call('terminal.read',{terminal:id,limit:lines});await pane(session,id,before.identity.identityToken);if(!Array.isArray(r.terminal?.tail)||r.terminal.tail.some((x:unknown)=>typeof x!=='string'))throw new BackendError('orca_protocol','Invalid terminal output');return {paneId:id,identityToken:before.identity.identityToken,revision:0,text:r.terminal.tail.join('\n'),truncated:!!r.terminal.truncated};},
    async transcript(session,id){const p=await pane(session,id);return {paneId:id,identityToken:p.identity.identityToken,source:'orca-terminal',supported:false,messages:[],cursor:null,reset:true,truncated:false,reason:'Orca terminal output is available; structured provider conversation import is not enabled'};},
    git:(s,w,p)=>inspect(s,w,p,async root=>({...await readWorkspaceGitStatus(w,root)})),
    diff:(s,w,path,p)=>inspect(s,w,p,async root=>({...await readWorkspaceGitDiff(w,root,path)})),
    files:(s,w,path,p)=>inspect(s,w,p,async root=>{if(isAbsolute(path))throw new BackendError('invalid_path','Directory must be workspace-relative',400);const directory=path.replace(/\/$/,'');if(directory&&(directory.split('/').some(x=>x==='..'||x==='.'||!x)||directory.includes('\0')))throw new BackendError('invalid_path','Invalid relative directory',400);const listing=await listWorkspaceFiles(root);if(directory&&!listing.entries.some(e=>e.kind==='directory'&&e.path===directory))throw new BackendError('directory_not_found','Directory missing',404);return {workspaceId:w,...listing,entries:listing.entries.filter(e=>{const at=e.path.lastIndexOf('/');return (at<0?'':e.path.slice(0,at))===directory;})};}),
    file:(s,w,path,p)=>inspect(s,w,p,async root=>({...await readWorkspaceFile(w,root,path)})),
    async terminal(o) {
      const before=await pane(o.session,o.paneId,o.expectedIdentityToken);if(!before.p.incarnationId||!before.p.ptyId||!(before.p.verdict==='live'||before.p.verdict===undefined&&before.p.executionHostId==='local'&&before.p.connected===true))throw new BackendError('orca_identity_unavailable','A live incarnation-bound Orca terminal is required',409);
      if(o.control&&controllers.has(o.paneId)){if(!o.takeover)throw new BackendError('control_conflict','A companion controller already owns this pane',409);controllers.get(o.paneId)!.close();}
      if(o.control&&!before.p.writable)throw new BackendError('read_only','Orca reports this pane is not writable',409);
      const rpc=new OrcaClient(connection,()=>close('orca_disconnected'));let closed=false;let first=true;let seq=0;let width=o.cols,height=o.rows;const clientId='ai-agent-remote-'+randomUUID();let finish!:()=>void,reject!:(error:unknown)=>void;
      const ready=new Promise<void>((a,b)=>{finish=a;reject=b;});const timer=setTimeout(()=>close('orca_stream_timeout'),10000);
      let controller:{send:(value:string,submit:boolean)=>Promise<unknown>;close:()=>void}|undefined;
      const close=(reason:string)=>{if(closed)return;closed=true;clearTimeout(timer);rpc.close();if(controller&&controllers.get(o.paneId)===controller)controllers.delete(o.paneId);handles.delete(handle);if(first)reject(new BackendError('orca_stream_unavailable','Orca did not supply a terminal snapshot'));o.onClose(reason);};
      const emit=(value:string,full:boolean)=>{if(closed)return;if(Buffer.byteLength(value)>524288||width<1||width>1000||height<1||height>1000)return close('frame_limit');o.onFrame({type:'pane_frame',paneId:o.paneId,identityToken:before.identity.identityToken,seq:seq++,full,width,height,bytes:Buffer.from(value).toString('base64')});};
      async function fence(){if(closed)throw new BackendError('terminal_closed','Orca stream closed',409);await pane(o.session,o.paneId,before.identity.identityToken);}
      async function claim(cols:number,rows:number) {await fence();const r=await rpc.call('terminal.updateViewport',{terminal:o.paneId,client:{id:clientId,type:'desktop'},viewport:{cols,rows},claim:true},true);if(r.updated!==true)throw new BackendError('control_conflict','Orca declined the terminal viewport claim',409);width=cols;height=rows;}
      const send=async(value:string,submit:boolean)=>{await fence();const r=await rpc.call('terminal.send',{terminal:o.paneId,expectedIncarnationId:before.p.incarnationId,text:value,enter:submit,agentPrompt:submit||undefined,requireWriteSettlement:true,client:{id:clientId,type:'desktop'}},true);if(r.send?.writeSettlement?.outcome==='unverifiable')throw new BackendError('delivery_unknown','Orca could not establish delivery',503,true);if(r.send?.accepted===true&&!r.send.writeSettlement&&!r.send.prompt)throw new BackendError('delivery_unknown','Orca did not report write settlement',503,true);if(r.send?.accepted!==true)throw new BackendError('orca_rejected','Orca declined terminal input',409);return r.send;};
      const handle:TerminalHandle={async command(v){if(!o.control)throw new BackendError('read_only','Observer cannot write or resize',403);if(v.type==='terminal.release'){close('released');return;}if(v.type==='terminal.resize'){if(!Number.isInteger(v.cols)||Number(v.cols)<20||Number(v.cols)>400||!Number.isInteger(v.rows)||Number(v.rows)<5||Number(v.rows)>200)throw new BackendError('invalid_dimensions','Invalid terminal dimensions',400);await claim(Number(v.cols),Number(v.rows));return;}if(v.type!=='terminal.input')throw new BackendError('unsupported_command','This Orca bridge does not support remote scroll commands',501);if((typeof v.text==='string')===(typeof v.bytes==='string'))throw new BackendError('invalid_input','Exactly one terminal input form is required',400);let value:string;try {value=typeof v.text==='string'?v.text:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(String(v.bytes),'base64'));}catch{throw new BackendError('invalid_input','Orca terminal input must be UTF-8',400);}await send(value,false);},close:()=>close('released')};
      handles.add(handle);
      try {
        if(o.control){const mode=await rpc.call('terminal.getDisplayMode',{terminal:o.paneId});if(mode.isPhoneFitted){if(!o.takeover)throw new BackendError('control_conflict','An Orca phone controls this terminal; request takeover explicitly',409);await rpc.call('terminal.restoreFit',{terminal:o.paneId},true);}}
        await rpc.subscribe({terminal:o.paneId,snapshotByteBudget:524288,...(o.control?{client:{id:clientId,type:'desktop'},viewport:{cols:o.cols,rows:o.rows},capabilities:{desktopViewportClaims:1}}:{})},v=>{
          if(v.type==='scrollback'){if(!first)return close('unexpected_snapshot');width=Number.isInteger(v.cols)?v.cols:width;height=Number.isInteger(v.rows)?v.rows:height;if(typeof v.serialized!=='string')return close('snapshot_unavailable');first=false;clearTimeout(timer);emit(v.serialized,true);finish();}
          else if(v.type==='data'&&!first&&typeof v.chunk==='string')emit(v.chunk,false);
          else if(v.type==='fit-override-changed'){if(Number.isInteger(v.cols)&&Number.isInteger(v.rows)){width=v.cols;height=v.rows;}if(o.control&&v.mode==='mobile-fit')close('control_taken_over');else emit('',false);}
          else if(v.type==='end')close('session_closed');
        });
        await ready;if(o.control){await claim(o.cols,o.rows);controller={send,close:handle.close};controllers.set(o.paneId,controller);}await fence();return handle;
      }catch(error){close('control_failed');throw error;}
    },
    async submitText(session,id,value,submit,expected) {await pane(session,id,expected);text(value,'text',65536);const control=controllers.get(id);if(!control)throw new BackendError('control_required','Acquire a companion control lease first',403);return control.send(value,submit);},
    async mutate(kind,session,body) {checkSession(session);if(kind==='workspace.create'){const cwd=text(body.cwd,'cwd');if(!isAbsolute(cwd))throw new BackendError('invalid_cwd','cwd must be absolute',400);return client().call('repo.add',{path:cwd,kind:'git',...(body.label?{displayName:text(body.label,'label',100)}:{})},true);}
      if(kind==='agent.start')throw new BackendError('agent_start_unsupported','Start agents in Orca; this bridge will not replace a live pane',501);
      if(kind==='tab.create'){const state=await catalog(session);const w=state.workspaces.find((w:any)=>w.worktreeId===body.workspaceId);if(!w)throw new BackendError('workspace_not_found','Workspace missing',404);if(body.cwd&&body.cwd!==w.path)throw new BackendError('cwd_unsupported','Orca chooses the terminal directory from its workspace',501);return client().call('terminal.create',{worktree:'id:'+text(body.workspaceId,'workspaceId'),...(body.label?{title:text(body.label,'label',100)}:{}),focus:false,activate:false,presentation:'background'},true);}
      const p=await pane(session,text(body.paneId,'paneId',256),text(body.identityToken,'identityToken',128));
      if(kind==='pane.split'){if(body.cwd&&body.cwd!==p.state.workspaces.find((w:any)=>w.worktreeId===p.p.worktreeId)?.path)throw new BackendError('cwd_unsupported','Orca chooses the split directory',501);if(!['right','down'].includes(String(body.direction)))throw new BackendError('invalid_direction','Invalid split direction',400);return client().call('terminal.split',{terminal:p.p.handle,direction:body.direction==='right'?'horizontal':'vertical',expectedIncarnationId:p.p.incarnationId,focus:false},true);}
      return client().call('terminal.close',{terminal:p.p.handle,expectedIncarnationId:p.p.incarnationId},true);
    },
    close(){if(stopped)return;stopped=true;for(const h of [...handles])h.close();api?.close();}
  };
}
