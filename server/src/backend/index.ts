import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { rpc } from './rpc';
import { openTerminal } from './terminal';
import { ttySize, boundedSize } from './pane-size';
import { readTranscript, type NativeSession } from './transcripts';
import { discoverSession } from './session-discovery';
import { HARNESSES, harnessByKind, installedHarnesses } from './harnesses';
import { BackendError, type HostBackend, type PaneIdentity, type TerminalHandle } from './types';
import { resolveWorkspaceRoot, listWorkspaceFiles, readWorkspaceFile, readWorkspaceGitStatus, readWorkspaceGitDiff, WorkspaceInspectionError } from './workspace-inspection';
export * from './types';
export interface HerdrBackendOptions {herdr?:string;session?:string;epoch?:string;configDir?:string;homeDir?:string;socketPath?:string;codexHome?:string;claudeConfigDir?:string;requireAgentBinary?:boolean;agentExecutable?:(kind:string)=>string|null}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const validName=(s:string)=>s!=='.'&&s!=='..'&&/^[A-Za-z0-9._-]{1,64}$/.test(s);
function modern(version:string):boolean {const m=/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);return !!m&&(Number(m[1])>0||Number(m[2])>9||(Number(m[2])===9&&Number(m[3])>=5));}
function string(value:unknown,name:string,max=4096):string {if(typeof value!=='string'||value.length===0||value.length>max||value.includes('\0'))throw new BackendError('invalid_argument',`Invalid ${name}`,400);return value;}
function pathArg(value:unknown):string {const p=string(value,'cwd');if(!isAbsolute(p))throw new BackendError('invalid_cwd','cwd must be absolute',400);return p;}
/** Public JSON socket adapter. The default socket is explicit/configured, never desktop focus. */
export function createHerdrBackend(options:HerdrBackendOptions={}):HostBackend {
  const home=options.homeDir??homedir();
  const configured=options.socketPath??(options.configDir?undefined:process.env.HERDR_SOCKET_PATH);
  let configDir=resolve(options.configDir??join((!options.homeDir?process.env.XDG_CONFIG_HOME:undefined)??join(home,'.config'),'herdr'));
  if(!options.configDir&&configured) { const dir=dirname(configured);configDir=dirname(dir).endsWith('/sessions')?dirname(dirname(dir)):dir; }
  const primary=options.session??(configured&&dirname(dirname(configured)).endsWith('/sessions')?dirname(configured).split('/').at(-1):undefined)??'default';
  const epoch=options.epoch??randomUUID(); const handles=new Set<TerminalHandle>();let closed=false;let transcriptActive=0;
  function selected(session?:string):string {const name=session||primary;if(!validName(name))throw new BackendError('invalid_session','Invalid session name',400);return name;}
  function socket(session:string):string {return session===primary&&configured?configured:session==='default'?join(configDir,'herdr.sock'):join(configDir,'sessions',session,'herdr.sock');}
  async function call(session:string,method:string,params:Record<string,unknown>={},write=false):Promise<any> {if(closed)throw new BackendError('backend_closed','Backend is closed');return rpc(socket(session),method,params,write);}
  async function raw(session:string):Promise<any> {
    const [reply,stat]=await Promise.all([call(session,'session.snapshot'),lstat(socket(session)).catch(()=>null)]);
    const s=reply.snapshot;
    if(!s||!Array.isArray(s.panes)||!Array.isArray(s.workspaces)||!Array.isArray(s.tabs)||s.panes.length>512)throw new BackendError('herdr_snapshot','Invalid or excessive Herdr snapshot');
    return {...s,_epoch:sha(`${epoch}:${session}:${stat?.dev}:${stat?.ino}:${stat?.ctimeMs}`)};
  }
  async function pane(session:string,paneId:string) {
    string(paneId,'paneId',128);const state=await raw(session);const p=state.panes.find((p:any)=>p.pane_id===paneId);
    if(!p)throw new BackendError('pane_not_found','Pane is not present in the selected session',404);
    let process:any;
    try{const r=await call(session,'pane.process_info',{pane_id:paneId}); process=r.process_info??r.process??r;}catch(e){if(e instanceof BackendError&&e.status===503)throw e;}
    return {state,p,process,identity:makeIdentity(state,p,process)};
  }
  function makeIdentity(state:any,p:any,process?:any):PaneIdentity {
    const processRef=(p.agent?process?.foreground_process_group_id:process?.shell_pid)??process?.shell_pid??null;
    return {paneId:p.pane_id,identityToken:sha(JSON.stringify([state._epoch,p.pane_id,p.terminal_id,p.agent??null,p.agent_session??null,processRef])),revision:p.revision??0,agent:p.agent??'shell',status:p.agent_status??'unknown'};
  }
  const requireAgentBinary=options.requireAgentBinary??process.env.HMR_REQUIRE_AGENT_BINARIES==='1';
  // The bridge may run without the login shell's PATH, so common per-user install folders are searched too.
  const agentExecutable=options.agentExecutable??((command:string)=>installedHarnesses().some(x=>x.command===command));
  // Herdr's agent.start validates its own labels; the phone is offered the ones installed here.
  const startable=()=>HARNESSES.filter(x=>x.herdr&&agentExecutable(x.command)).map(x=>x.kind);
  const caps=(s:any)=>{const kinds=startable();return {output:true,terminalObserve:true,terminalControl:true,transcript:true,git:true,files:true,submitText:true,atomicSubmit:modern(s.version),workspaceCreate:true,tabCreate:true,paneSplit:true,paneClose:true,agentStart:modern(s.version),agentKinds:kinds.length?kinds:['claude','codex'],agentStartSetupRequired:requireAgentBinary&&!kinds.length};};
  async function inspect<T>(session:string|undefined,workspaceId:string,paneId:string|undefined,fn:(root:string)=>Promise<T>):Promise<T> {
    try {
      const state=await raw(selected(session));const w=state.workspaces.find((w:any)=>w.workspace_id===workspaceId);
      if(!w)throw new BackendError('workspace_not_found','Workspace is not present in this session',404);
      const panes=state.panes.filter((p:any)=>p.workspace_id===workspaceId);
      if(paneId&&!panes.some((p:any)=>p.pane_id===paneId))throw new BackendError('pane_not_found','Pane does not belong to this workspace',404);
      // A pane selector cannot bypass the multi-repository ambiguity rule.
      const root=await resolveWorkspaceRoot(w.worktree?.checkout_path,panes.map((p:any)=>p.foreground_cwd||p.cwd).filter(Boolean));
      return await fn(root);
    }catch(e){if(e instanceof WorkspaceInspectionError)throw new BackendError('inspection_unavailable',e.message,e.status===422?409:e.status);throw e;}
  }
  return {
    async snapshot(session) {
      const name=selected(session),state=await raw(name);
      const projected=[];
      // Bound parallel OS process discovery. No argv/cmdline is projected to clients.
      for(let start=0;start<state.panes.length;start+=8)projected.push(...await Promise.all(state.panes.slice(start,start+8).map(async(p:any)=>{
        let process:any;try{const r=await call(name,'pane.process_info',{pane_id:p.pane_id});process=r.process_info??r.process??r;}catch{}
        const w=state.workspaces.find((w:any)=>w.workspace_id===p.workspace_id);
        return {...makeIdentity(state,p,process),workspaceId:p.workspace_id,workspaceLabel:w?.label??'',workspaceNumber:w?.number??0,tabId:p.tab_id,agent:p.agent??'shell',kind:p.agent?'agent':'shell',status:p.agent_status??'unknown',cwd:p.foreground_cwd||p.cwd||'/',focused:!!p.focused,
          ...(p.agent_session?{agentSession:p.agent_session}:{}),...(process?{process:{shellPid:process.shell_pid,foregroundProcessGroupId:process.foreground_process_group_id,foregroundProcesses:(process.foreground_processes??[]).map((p:any)=>({pid:p.pid,name:p.name,cwd:p.cwd}))}}:{})};
      })));
      const names=new Set<string>([primary]);if(await lstat(join(configDir,'herdr.sock')).catch(()=>null))names.add('default');
      for(const entry of await readdir(join(configDir,'sessions'),{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory()&&validName(entry.name)&&await lstat(join(configDir,'sessions',entry.name,'herdr.sock')).catch(()=>null))names.add(entry.name);
      const sessions=await Promise.all([...names].sort((a,b)=>a===primary?-1:b===primary?1:a.localeCompare(b)).slice(0,64).map(async n=>{
        const s=n===name?state:await raw(n).catch(()=>null);const agents=s?.panes.filter((p:any)=>p.agent)??[];
        return {name:n,isPrimary:n===primary,reachable:!!s,agents:agents.length,working:agents.filter((p:any)=>p.agent_status==='working').length,blocked:agents.filter((p:any)=>p.agent_status==='blocked').length};
      }));
      return {bridge:'connected',backend:{kind:'herdr',name:'Herdr',version:state.version,controlScope:'native'},session:name,epoch:state._epoch,herdrVersion:state.version,herdrProtocol:state.protocol,capabilities:caps(state),agents:projected.filter((p:any)=>p.kind==='agent'),shellPanes:projected.filter((p:any)=>p.kind==='shell'),
        workspaces:state.workspaces.map((w:any)=>({workspaceId:w.workspace_id,number:w.number,label:w.label,focused:w.focused,activeTabId:w.active_tab_id,tabCount:w.tab_count,paneCount:w.pane_count,...(w.worktree?{worktree:{repoKey:w.worktree.repo_key,repoName:w.worktree.repo_name,repoRoot:w.worktree.repo_root,checkoutPath:w.worktree.checkout_path,isLinkedWorktree:w.worktree.is_linked_worktree}}:{})})),
        tabs:state.tabs.map((t:any)=>({tabId:t.tab_id,workspaceId:t.workspace_id,number:t.number,label:t.label,focused:t.focused,paneCount:t.pane_count})),sessions,ts:Date.now()};
    },
    async identity(session,paneId){return (await pane(selected(session),paneId)).identity;},
    async output(session,paneId,lines=240) {
      if(!Number.isInteger(lines)||lines<1||lines>2000)throw new BackendError('invalid_lines','lines must be between 1 and 2000',400);
      const name=selected(session),before=await pane(name,paneId);
      const r=await call(name,'pane.read',{pane_id:paneId,source:'recent_unwrapped',format:'ansi',strip_ansi:false,lines});
      const read=r.read??r; const after=await pane(name,paneId);
      if(before.identity.identityToken!==after.identity.identityToken)throw new BackendError('identity_changed','Pane identity changed during the read',409);
      const full=typeof read.text==='string'?read.text:'';const bytes=Buffer.from(full);const max=1024*1024;
      return {paneId,identityToken:after.identity.identityToken,text:bytes.subarray(Math.max(0,bytes.length-max)).toString('utf8'),truncated:!!read.truncated||bytes.length>max,revision:read.revision??after.identity.revision};
    },
    async transcript(session,paneId,cursor,tail) {
      const name=selected(session),before=await pane(name,paneId);
      if(transcriptActive>=4)throw new BackendError('transcript_busy','Too many transcript reads',429);
      transcriptActive++;
      try {
        const codexHome=options.codexHome??(!options.homeDir?process.env.CODEX_HOME:undefined);
        const claudeHome=options.claudeConfigDir??(!options.homeDir?process.env.CLAUDE_CONFIG_DIR:undefined);
        const piSessions=!options.homeDir?process.env.PI_CODING_AGENT_SESSION_DIR:undefined,qwenHome=!options.homeDir?process.env.QWEN_HOME:undefined;
        const roots={...(codexHome?{codex:join(codexHome,'sessions')}:{}),...(claudeHome?{claude:join(claudeHome,'projects')}:{}),...(piSessions?{pi:piSessions}:{}),...(qwenHome?{qwen:join(qwenHome,'projects')}:{})};
        let native=before.p.agent_session as NativeSession|undefined;
        // Herdr only learns a session from the agent's start hook; agents started before it was installed,
        // or through a resume picker, have none, so look for their log here.
        if(!native&&before.p.agent){
          const cwd=before.p.foreground_cwd||before.p.cwd;
          native=await discoverSession(before.p.agent,(before.process?.foreground_processes??[]).map((x:any)=>({pid:x.pid,name:x.name,cwd:x.cwd,argv:Array.isArray(x.argv)?x.argv:undefined})),
            {codex:roots.codex??join(home,'.codex/sessions'),claude:roots.claude??join(home,'.claude/projects')},
            {claimed:new Set(before.state.panes.map((x:any)=>x.agent_session?.value).filter(Boolean)),sharedFolder:before.state.panes.some((x:any)=>x.pane_id!==paneId&&x.agent===before.p.agent&&!x.agent_session&&(x.foreground_cwd||x.cwd)===cwd),title:typeof before.p.terminal_title_stripped==='string'?before.p.terminal_title_stripped:undefined,
             screen:async()=>{const r=await call(name,'pane.read',{pane_id:paneId,source:'recent_unwrapped',format:'text',lines:400});return String((r.read??r).text??'');}});
        }
        const result=await readTranscript(home,native,before.identity.identityToken,cursor,roots,typeof tail==='string'?tail:tail===true);
        if((await pane(name,paneId)).identity.identityToken!==before.identity.identityToken)throw new BackendError('identity_changed','Pane identity changed during transcript read',409);
        return {paneId,identityToken:before.identity.identityToken,...result};
      }finally{transcriptActive--;}
    },
    git:(s,w,p)=>inspect(s,w,p,root=>readWorkspaceGitStatus(w,root)) as Promise<any>,
    diff:(s,w,path,p)=>inspect(s,w,p,root=>readWorkspaceGitDiff(w,root,path)) as Promise<any>,
    files:(s,w,path,p)=>inspect(s,w,p,async root=>{if(isAbsolute(path))throw new BackendError('invalid_path','Directory must be workspace-relative',400);const directory=path.replace(/\/$/,'');if(directory&&(isAbsolute(directory)||directory.split('/').some(x=>x==='..'||x==='.'||!x)||directory.includes('\0')))throw new BackendError('invalid_path','Invalid relative directory',400);const listing=await listWorkspaceFiles(root);if(directory&&!listing.entries.some(e=>e.kind==='directory'&&e.path===directory))throw new BackendError('directory_not_found','Workspace directory was not found',404);return {workspaceId:w,...listing,entries:listing.entries.filter(e=>{const at=e.path.lastIndexOf('/');return (at<0?'':e.path.slice(0,at))===directory;})};}),
    file:(s,w,path,p)=>inspect(s,w,p,root=>readWorkspaceFile(w,root,path)) as Promise<any>,
    async paneSize(session,paneId) {
      const name=selected(session);string(paneId,'paneId',128);
      try{const r=await call(name,'pane.process_info',{pane_id:paneId});const info=r.process_info??r.process??r;const size=await ttySize(info?.shell_pid);if(size)return size;}catch(e){if(e instanceof BackendError&&e.status===404)throw e;}
      // Layout rectangles include pane chrome; they are only a fallback when the PTY cannot be inspected.
      try{const r=await call(name,'pane.layout',{pane_id:paneId});const rect=r.layout?.panes?.find((p:any)=>p.pane_id===paneId)?.rect;if(Number.isInteger(rect?.width)&&Number.isInteger(rect?.height))return boundedSize({cols:rect.width,rows:rect.height});}catch{}
      return {cols:120,rows:40};
    },
    async terminal(o) {
      if(!Number.isInteger(o.cols)||o.cols<20||o.cols>400||!Number.isInteger(o.rows)||o.rows<5||o.rows>200)throw new BackendError('invalid_dimensions','Invalid terminal dimensions',400);
      const name=selected(o.session),p=await pane(name,o.paneId);
      if(o.expectedIdentityToken&&o.expectedIdentityToken!==p.identity.identityToken)throw new BackendError('identity_changed','Pane identity changed before terminal admission',409);
      const handle=await openTerminal({...o,herdr:options.herdr??Bun.which('herdr')??join(home,'.local/bin/herdr'),session:name,configDir,socketPath:socket(name),identityToken:p.identity.identityToken});handles.add(handle);return {command:v=>handle.command(v),close(){handles.delete(handle);handle.close();}};
    },
    async submitText(session,paneId,text,submit,expectedIdentityToken) {
      if(typeof text!=='string'||Buffer.byteLength(text)>65536||text.includes('\0'))throw new BackendError('invalid_text','Input must be bounded UTF-8 text',400);
      const name=selected(session),p=await pane(name,paneId);
      if(expectedIdentityToken&&expectedIdentityToken!==p.identity.identityToken)throw new BackendError('identity_changed','Pane identity changed before input dispatch',409);
      if(submit&&p.p.agent) {
        if(modern(p.state.version))return call(name,'agent.prompt',{target:paneId,text},true);
        // Older Herdr has no agent.prompt. Agent TUIs enable bracketed paste, so send the text as
        // one paste (multi-line text stays one message), then Enter separately so it submits.
        if(/\x1b\[20[01]~/.test(text))throw new BackendError('invalid_text','Text cannot contain paste markers',400);
        await call(name,'pane.send_input',{pane_id:paneId,text:`\x1b[200~${text}\x1b[201~`,keys:[]},true);
        await Bun.sleep(60);
        return call(name,'pane.send_input',{pane_id:paneId,text:'',keys:['Enter']},true);
      }
      return call(name,'pane.send_input',{pane_id:paneId,text,keys:submit?['Enter']:[]},true);
    },
    async mutate(kind,session,body) {
      const name=selected(session);const p=body.paneId?await pane(name,string(body.paneId,'paneId',128)):null;
      const state=p?.state??await raw(name);
      if(body.identityToken&&p?.identity.identityToken!==body.identityToken)throw new BackendError('identity_changed','Pane identity changed',409);
      let params:Record<string,unknown>;
      if(kind==='workspace.create')params={cwd:pathArg(body.cwd),...(body.label?{label:string(body.label,'label',128)}:{}),focus:false};
      else if(kind==='tab.create'){const id=string(body.workspaceId,'workspaceId',128);if(!state.workspaces.some((w:any)=>w.workspace_id===id))throw new BackendError('workspace_not_found','Workspace not found',404);params={workspace_id:id,focus:false,...(body.cwd?{cwd:pathArg(body.cwd)}:{}),...(body.label?{label:string(body.label,'label',128)}:{})};}
      else {
        if(!p)throw new BackendError('missing_target','Explicit pane target is required',400);
        if(kind==='pane.split'){if(!['right','down'].includes(String(body.direction)))throw new BackendError('invalid_direction','Split must be right or down',400);params={target_pane_id:p.p.pane_id,direction:body.direction,focus:false,...(body.cwd?{cwd:pathArg(body.cwd)}:{})};}
        else if(kind==='pane.close')params={pane_id:p.p.pane_id};
        else {if(!modern(state.version))throw new BackendError('agent_start_unsupported','This Herdr version creates layout in agent.start and cannot safely start in the selected pane',501);params={pane_id:p.p.pane_id,name:string(body.name,'name',32),kind:string(body.kind,'agent kind',32)};const harness=harnessByKind(String(params.kind));if(!harness?.herdr)throw new BackendError('agent_kind_unsupported','Herdr cannot start this agent kind',501);if(!/^[a-z][a-z0-9_-]{0,31}$/.test(String(params.name)))throw new BackendError('invalid_name','Invalid agent name',400);if(requireAgentBinary&&!agentExecutable(harness.command))throw new BackendError('agent_not_installed','Install and configure this agent tool in the coding environment first',501);}
      }
      return call(name,kind,params,true);
    },
    close(){closed=true;for(const h of handles)h.close();handles.clear();},
  };
}
