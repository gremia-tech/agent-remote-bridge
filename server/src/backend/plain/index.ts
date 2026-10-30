import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,statSync,writeFileSync,renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,isAbsolute,join,resolve} from 'node:path';
import {Terminal as Screen} from '@xterm/headless';
import {SerializeAddon} from '@xterm/addon-serialize';
import {BackendError,type HostBackend,type PaneIdentity,type TerminalFrame,type TerminalHandle} from '../types';
import {resolveWorkspaceRoot,listWorkspaceFiles,readWorkspaceFile,readWorkspaceGitStatus,readWorkspaceGitDiff,WorkspaceInspectionError} from '../workspace-inspection';
import {harnessByKind,harnessFor,installedHarnesses,type Harness} from '../harnesses';
import {discoverSession,processCwd} from '../session-discovery';
import {readTranscript,type NativeSession} from '../transcripts';

/** Plain terminals: the bridge runs its own shells, no Herdr or Orca needed. Workspaces are folders
 *  the owner chose (saved in the state directory); terminals live as long as the bridge does. */
export interface PlainBackendOptions {stateDir:string;epoch?:string;shell?:string;folders?:string[];env?:Record<string,string|undefined>}
interface Workspace {id:string;number:number;label:string;cwd:string}
interface Tab {id:string;workspaceId:string;number:number;label:string}
interface Viewer {control:boolean;emit(frame:Omit<TerminalFrame,'paneId'|'identityToken'|'type'>):void;close(reason:string):void}
interface Pane {id:string;tabId:string;workspaceId:string;proc:Bun.Subprocess;screen:Screen;serializer:SerializeAddon;
  cols:number;rows:number;seq:number;viewers:Set<Viewer>;controller?:Viewer;foreground?:{pgid:number;harness?:Harness;agent?:{pid:number;name:string;argv:string[]}};session?:{pid:number;title?:string;native:NativeSession};title?:string;exited:boolean}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(value:unknown,name:string,max=4096):string=>{if(typeof value!=='string'||!value||value.length>max||value.includes('\0'))throw new BackendError('invalid_argument',`Invalid ${name}`,400);return value;};
const SCROLLBACK=5000;

export function createPlainBackend(options:PlainBackendOptions):HostBackend {
  const epoch=options.epoch??randomUUID(),store=join(options.stateDir,'plain-workspaces.json');
  const shell=options.shell??process.env.SHELL??'/bin/sh';
  const workspaces=new Map<string,Workspace>(),tabs=new Map<string,Tab>(),panes=new Map<string,Pane>();
  let next={workspace:1,tab:1,pane:1},stopped=false;

  function save() {
    const folders=[...workspaces.values()].map(w=>({cwd:w.cwd,label:w.label}));
    const temp=`${store}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify({version:1,folders},null,2)+'\n',{mode:0o600});renameSync(temp,store);
  }
  function folder(cwd:string) {
    if(!isAbsolute(cwd))throw new BackendError('invalid_cwd','Folder must be an absolute path',400);
    const path=resolve(cwd);let info;try{info=statSync(path);}catch{throw new BackendError('invalid_cwd','Folder does not exist',400);}
    if(!info.isDirectory())throw new BackendError('invalid_cwd','Folder is not a directory',400);
    return path;
  }
  function addWorkspace(cwd:string,label?:string) {
    const id=`w${next.workspace++}`,w={id,number:Math.max(0,...[...workspaces.values()].map(w=>w.number))+1,label:label||basename(cwd)||cwd,cwd};
    workspaces.set(id,w);return w;
  }
  function addTab(w:Workspace,label?:string) {
    const id=`${w.id}:t${next.tab++}`,t={id,workspaceId:w.id,number:[...tabs.values()].filter(t=>t.workspaceId===w.id).length+1,label:label??''};
    tabs.set(id,t);return t;
  }
  function spawnPane(t:Tab,cwd:string):Pane {
    const id=`${t.workspaceId}:p${next.pane++}`,cols=120,rows=40;
    const screen=new Screen({cols,rows,scrollback:SCROLLBACK,allowProposedApi:true}),serializer=new SerializeAddon();screen.loadAddon(serializer);
    // The shell starts like a fresh terminal window: login shell, the owner's environment, no inherited multiplexer markers.
    const env:Record<string,string|undefined>={...(options.env??process.env),TERM:'xterm-256color',COLORTERM:'truecolor',AGENT_REMOTE_PANE:id};
    for(const key of Object.keys(env))if(key.startsWith('HERDR_')||key==='TMUX'||key==='ORCA_RUNTIME')delete env[key];
    let pane!:Pane;
    const proc=Bun.spawn([shell,'-l'],{cwd,env,terminal:{cols,rows,name:'xterm-256color',
      data:(_t,data)=>{const bytes=Buffer.from(data);screen.write(bytes,()=>{if(pane.screen.buffer.active.viewportY!==pane.screen.buffer.active.baseY){pane.screen.scrollToBottom();broadcastFull(pane);}else broadcast(pane,bytes);});}}});
    pane={id,tabId:t.id,workspaceId:t.workspaceId,proc,screen,serializer,cols,rows,seq:0,viewers:new Set(),exited:false};
    screen.onTitleChange(title=>{pane.title=title;});
    panes.set(id,pane);
    proc.exited.then(()=>{pane.exited=true;closePane(pane,'session_closed');});
    return pane;
  }
  function closePane(p:Pane,reason:string) {
    if(!panes.delete(p.id))return;
    for(const v of [...p.viewers])v.close(reason);
    if(!p.exited){try{p.proc.kill('SIGHUP');}catch{}setTimeout(()=>{if(!p.exited)try{p.proc.kill('SIGKILL');}catch{}},3000).unref();}
    try{p.proc.terminal?.close();}catch{}p.screen.dispose();
    if(![...panes.values()].some(x=>x.tabId===p.tabId))tabs.delete(p.tabId);
    if(![...panes.values()].some(x=>x.workspaceId===p.workspaceId)){workspaces.delete(p.workspaceId);if(!stopped)save();}
  }
  function full(p:Pane):Omit<TerminalFrame,'paneId'|'identityToken'|'type'> {
    const b=p.screen.buffer.active,scrolled=b.viewportY!==b.baseY;
    const bytes=scrolled?p.serializer.serialize({range:{start:b.viewportY,end:b.viewportY+p.rows-1}}):p.serializer.serialize({scrollback:0});
    return {seq:p.seq++,full:true,width:p.cols,height:p.rows,bytes:Buffer.from(bytes).toString('base64')};
  }
  function broadcastFull(p:Pane){if(!p.viewers.size)return;const frame=full(p);for(const v of p.viewers)v.emit(frame);}
  function broadcast(p:Pane,bytes:Buffer){if(!p.viewers.size){p.seq++;return;}const frame={seq:p.seq++,full:false,width:p.cols,height:p.rows,bytes:bytes.toString('base64')};for(const v of p.viewers)v.emit(frame);}
  const settled=(p:Pane)=>new Promise<void>(done=>p.screen.write('',()=>done()));

  /** One process-table read per snapshot: which program holds each terminal's foreground. `ps` blocks the
   *  event loop (and every live frame) while it runs, so reads within `maxAge` ms of the last one reuse it:
   *  a snapshot and the identity check of each watched terminal arrive together every couple of seconds. */
  let foregroundAt=0;
  function readForeground(maxAge=250) {
    const now=Date.now();if(maxAge>0&&now-foregroundAt<maxAge)return;foregroundAt=now;
    const result=Bun.spawnSync(['ps','-A','-o','pid=,pgid=,tpgid=,comm=,args='],{stdout:'pipe',stderr:'ignore'});
    if(!result.success)return;
    const rows=result.stdout.toString().split('\n').map(line=>line.trim().split(/\s+/)).filter(r=>r.length>=4).map(r=>({pid:Number(r[0]),pgid:Number(r[1]),tpgid:Number(r[2]),comm:r[3]!,args:r.slice(4)}));
    const byPid=new Map(rows.map(r=>[r.pid,r]));
    for(const p of panes.values()) {
      const shellRow=byPid.get(p.proc.pid);const pgid=shellRow&&shellRow.tpgid>0?shellRow.tpgid:p.proc.pid;
      if(pgid===p.proc.pid){p.foreground={pgid};continue;}
      let harness:Harness|undefined,agent:{pid:number;name:string;argv:string[]}|undefined;
      for(const r of rows)if(r.pgid===pgid&&(harness=harnessFor(r.comm,r.args))){agent={pid:r.pid,name:r.comm,argv:r.args};break;}
      p.foreground={pgid,...(harness?{harness,agent}:{})};
    }
  }
  function identity(p:Pane):PaneIdentity {
    const agent=p.foreground?.harness?.kind;
    return {paneId:p.id,identityToken:sha([epoch,p.id,p.proc.pid,agent??null,agent?p.foreground!.pgid:p.proc.pid]),revision:p.seq,agent:agent??'shell',status:'unknown'};
  }
  function pane(id:unknown,expected?:string,refresh=true):Pane {
    const p=panes.get(text(id,'pane',128));if(!p||p.exited)throw new BackendError('pane_not_found','Terminal is not running',404);
    if(expected){if(refresh)readForeground(0);if(identity(p).identityToken!==expected)throw new BackendError('identity_changed','Terminal identity changed',409);}
    return p;
  }
  const checkSession=(session?:string)=>{if(stopped)throw new BackendError('backend_closed','Backend is closed');if(session&&session!=='default')throw new BackendError('invalid_session','Plain terminals have one session',400);};
  async function inspect<T>(session:string|undefined,workspaceId:string,paneId:string|undefined,fn:(root:string)=>Promise<T>):Promise<T> {
    checkSession(session);const w=workspaces.get(workspaceId);if(!w)throw new BackendError('workspace_not_found','Workspace is not present',404);
    if(paneId&&panes.get(paneId)?.workspaceId!==workspaceId)throw new BackendError('pane_not_found','Terminal does not belong to this workspace',404);
    try{return await fn(await resolveWorkspaceRoot(w.cwd,[w.cwd]));}catch(e){if(e instanceof WorkspaceInspectionError)throw new BackendError('inspection_unavailable',e.message,e.status===422?409:e.status);throw e;}
  }
  /** Mobile scroll gestures: wheel events for apps that track the mouse, arrow keys for other
   *  full-screen apps, and the bridge's own scrollback for a plain shell. */
  function scroll(p:Pane,direction:'up'|'down',lines:number) {
    const b=p.screen.buffer.active,modes=p.screen.modes;
    if(modes.mouseTrackingMode!=='none'){const x=Math.ceil(p.cols/2),y=Math.ceil(p.rows/2);p.proc.terminal!.write(`\x1b[<${direction==='up'?64:65};${x};${y}M`.repeat(Math.max(1,Math.round(lines/3))));return;}
    if(b.type==='alternate'){p.proc.terminal!.write((modes.applicationCursorKeysMode?(direction==='up'?'\x1bOA':'\x1bOB'):(direction==='up'?'\x1b[A':'\x1b[B')).repeat(Math.min(lines,50)));return;}
    p.screen.scrollLines(direction==='up'?-lines:lines);broadcastFull(p);
  }

  // Start with the owner's folders: the ones saved last time, else those passed in, else home.
  let saved:{cwd:string;label?:string}[]=[];
  try{if(existsSync(store))saved=(JSON.parse(readFileSync(store,'utf8')).folders??[]).filter((f:any)=>typeof f?.cwd==='string');}catch{}
  const initial:{cwd:string;label?:string}[]=saved.length?saved:(options.folders?.length?options.folders:[homedir()]).map(cwd=>({cwd}));
  for(const f of initial){try{const cwd=folder(f.cwd);spawnPane(addTab(addWorkspace(cwd,f.label)),cwd);}catch{}}
  if(workspaces.size)save();
  const env=options.env??process.env;const codexHome=env.CODEX_HOME??join(env.HOME??homedir(),'.codex'),claudeHome=env.CLAUDE_CONFIG_DIR??join(env.HOME??homedir(),'.claude');
  const available=()=>installedHarnesses((options.env??process.env).PATH,(options.env??process.env).HOME??homedir()).map(x=>x.kind);

  return {
    async snapshot(session) {
      checkSession(session);readForeground();
      const rows=[...panes.values()].filter(p=>!p.exited).map(p=>{const w=workspaces.get(p.workspaceId)!;const i=identity(p);
        return {...i,workspaceId:w.id,workspaceLabel:w.label,workspaceNumber:w.number,tabId:p.tabId,kind:i.agent==='shell'?'shell':'agent',cwd:w.cwd,focused:false};});
      const agents=rows.filter(r=>r.kind==='agent');
      return {bridge:'connected',backend:{kind:'plain',name:'Terminals',version:null,controlScope:'bridge'},session:'default',epoch,
        capabilities:{output:true,terminalObserve:true,terminalControl:true,transcript:true,git:true,files:true,submitText:true,atomicSubmit:true,workspaceCreate:true,tabCreate:true,paneSplit:true,paneClose:true,agentStart:true,agentKinds:available()},
        agents,shellPanes:rows.filter(r=>r.kind==='shell'),
        workspaces:[...workspaces.values()].map(w=>({workspaceId:w.id,number:w.number,label:w.label,focused:false,tabCount:[...tabs.values()].filter(t=>t.workspaceId===w.id).length,paneCount:rows.filter(r=>r.workspaceId===w.id).length})),
        tabs:[...tabs.values()].map(t=>({tabId:t.id,workspaceId:t.workspaceId,number:t.number,label:t.label,focused:false,paneCount:rows.filter(r=>r.tabId===t.id).length})),
        sessions:[{name:'default',isPrimary:true,reachable:true,agents:agents.length,working:0,blocked:0}],ts:Date.now()};
    },
    async identity(session,id){checkSession(session);const p=pane(id);readForeground();return identity(p);},
    async output(session,id,lines=240) {
      checkSession(session);if(!Number.isInteger(lines)||lines<1||lines>2000)throw new BackendError('invalid_lines','lines must be between 1 and 2000',400);
      const p=pane(id);await settled(p);readForeground();const b=p.screen.buffer.active;
      // Wrapped rows are joined so the phone can rewrap them to its own width.
      let last=b.length-1;while(last>0&&!b.getLine(last)!.translateToString(true).trim())last--;
      const out:string[]=[];for(let y=last;y>=0&&out.length<lines;y--){let line=b.getLine(y)!.translateToString(true);while(y>0&&b.getLine(y)!.isWrapped){y--;line=b.getLine(y)!.translateToString(true)+line;}out.unshift(line);}
      while(out.length&&!out[out.length-1]!.trim())out.pop();
      return {paneId:p.id,identityToken:identity(p).identityToken,revision:p.seq,text:out.join('\n'),truncated:b.length>lines};
    },
    async transcript(session,id,cursor,tail) {
      checkSession(session);const p=pane(id);readForeground();const token=identity(p).identityToken;
      const agent=p.foreground?.agent,kind=p.foreground?.harness?.kind;
      // The agent's own log, found on this computer the same way as for Herdr panes without a session reference.
      // Codex retitles its terminal when another thread is resumed in the same process.
      if(agent&&kind&&(p.session?.pid!==agent.pid||p.session.title!==p.title)){
        const cwd=await processCwd(agent.pid);
        const others=[...panes.values()].filter(o=>o!==p&&o.foreground?.harness?.kind===kind);
        const native=await discoverSession(kind,[{...agent,...(cwd?{cwd}:{})}],{codex:join(codexHome,'sessions'),claude:join(claudeHome,'projects')},
          {claimed:new Set(others.map(o=>o.session?.native.value).filter((v):v is string=>!!v)),sharedFolder:(await Promise.all(others.map(o=>o.foreground?.agent?processCwd(o.foreground.agent.pid):undefined))).includes(cwd),title:p.title,
           screen:async()=>String(((await this.output(session,id,400)) as {text?:string}).text??"")});
        p.session=native?{pid:agent.pid,title:p.title,native}:undefined;
      }
      if(!agent||!p.session)return {paneId:p.id,identityToken:token,source:'plain-terminal',supported:false,reason:'native_session_unavailable',messages:[],cursor:null,reset:!!cursor,truncated:false,hasMore:false};
      return {paneId:p.id,identityToken:token,...await readTranscript(env.HOME??homedir(),p.session.native,token,cursor,{codex:join(codexHome,'sessions'),claude:join(claudeHome,'projects')},typeof tail==='string'?tail:tail===true)};
    },
    git:(s,w,p)=>inspect(s,w,p,root=>readWorkspaceGitStatus(w,root)) as Promise<any>,
    diff:(s,w,path,p)=>inspect(s,w,p,root=>readWorkspaceGitDiff(w,root,path)) as Promise<any>,
    files:(s,w,path,p)=>inspect(s,w,p,async root=>{if(isAbsolute(path))throw new BackendError('invalid_path','Directory must be workspace-relative',400);const directory=path.replace(/\/$/,'');if(directory&&(directory.split('/').some(x=>x==='..'||x==='.'||!x)||directory.includes('\0')))throw new BackendError('invalid_path','Invalid relative directory',400);const listing=await listWorkspaceFiles(root);if(directory&&!listing.entries.some(e=>e.kind==='directory'&&e.path===directory))throw new BackendError('directory_not_found','Workspace directory was not found',404);return {workspaceId:w,...listing,entries:listing.entries.filter(e=>{const at=e.path.lastIndexOf('/');return (at<0?'':e.path.slice(0,at))===directory;})};}),
    file:(s,w,path,p)=>inspect(s,w,p,root=>readWorkspaceFile(w,root,path)) as Promise<any>,
    async paneSize(session,id){checkSession(session);const p=pane(id);return {cols:p.cols,rows:p.rows};},
    async terminal(o) {
      checkSession(o.session);
      if(!Number.isInteger(o.cols)||o.cols<20||o.cols>400||!Number.isInteger(o.rows)||o.rows<5||o.rows>200)throw new BackendError('invalid_dimensions','Invalid terminal dimensions',400);
      const p=pane(o.paneId,o.expectedIdentityToken);const token=identity(p).identityToken;
      if(o.control&&p.controller){if(!o.takeover)throw new BackendError('controller_conflict','Another device controls this terminal',409);p.controller.close('control_taken_over');}
      let closed=false;
      const viewer:Viewer={control:o.control,emit:frame=>{if(!closed)o.onFrame({type:'pane_frame',paneId:p.id,identityToken:token,...frame});},
        close:reason=>{if(closed)return;closed=true;p.viewers.delete(viewer);if(p.controller===viewer){p.controller=undefined;if(p.screen.buffer.active.viewportY!==p.screen.buffer.active.baseY){p.screen.scrollToBottom();broadcastFull(p);}}o.onClose(reason);}};
      await settled(p);
      if(o.control)p.controller=viewer;
      p.viewers.add(viewer);viewer.emit(full(p));
      return {
        async command(v) {
          if(closed)throw new BackendError('terminal_closed','Terminal stream is closed',409);
          if(!o.control||p.controller!==viewer)throw new BackendError('read_only','Observer cannot write or resize',403);
          if(Buffer.byteLength(JSON.stringify(v))>100_000)throw new BackendError('input_limit','Terminal command exceeds the limit',413);
          if(v.type==='terminal.release'){viewer.close('released');return;}
          if(v.type==='terminal.resize'){
            if(!Number.isInteger(v.cols)||Number(v.cols)<20||Number(v.cols)>400||!Number.isInteger(v.rows)||Number(v.rows)<5||Number(v.rows)>200)throw new BackendError('invalid_dimensions','Invalid terminal dimensions',400);
            p.cols=Number(v.cols);p.rows=Number(v.rows);p.proc.terminal!.resize(p.cols,p.rows);p.screen.resize(p.cols,p.rows);await settled(p);broadcastFull(p);return;
          }
          if(v.type==='terminal.scroll'){if(!['up','down'].includes(String(v.direction))||!Number.isInteger(v.lines)||Number(v.lines)<1||Number(v.lines)>1000)throw new BackendError('invalid_scroll','Invalid scroll command',400);scroll(p,v.direction as 'up'|'down',Number(v.lines));return;}
          if(v.type!=='terminal.input')throw new BackendError('invalid_command','Unknown terminal command',400);
          if((typeof v.text==='string')===(typeof v.bytes==='string'))throw new BackendError('invalid_input','Exactly one text or bytes field is required',400);
          if(typeof v.bytes==='string'&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.bytes))throw new BackendError('invalid_input','bytes must be base64',400);
          if(p.screen.buffer.active.viewportY!==p.screen.buffer.active.baseY){p.screen.scrollToBottom();broadcastFull(p);}
          p.proc.terminal!.write(typeof v.text==='string'?v.text:Buffer.from(v.bytes as string,'base64'));
        },
        close:()=>viewer.close('released'),
      };
    },
    async submitText(session,id,value,submit,expected) {
      checkSession(session);if(typeof value!=='string'||Buffer.byteLength(value)>65536||value.includes('\0'))throw new BackendError('invalid_text','Input must be bounded UTF-8 text',400);
      const p=pane(id,expected);const term=p.proc.terminal!;
      // Agent TUIs turn on bracketed paste: one paste keeps multi-line text one message, then Enter submits it.
      if(p.screen.modes.bracketedPasteMode){if(/\x1b\[20[01]~/.test(value))throw new BackendError('invalid_text','Text cannot contain paste markers',400);term.write(`\x1b[200~${value}\x1b[201~`);if(submit){await Bun.sleep(60);term.write('\r');}}
      else term.write(value+(submit?'\r':''));
      return {accepted:true};
    },
    async mutate(kind,session,body) {
      checkSession(session);
      if(kind==='workspace.create'){const cwd=folder(text(body.cwd,'cwd'));const w=addWorkspace(cwd,typeof body.label==='string'?text(body.label,'label',100):undefined);const p=spawnPane(addTab(w),cwd);save();return {workspace:{workspaceId:w.id},pane:{paneId:p.id}};}
      if(kind==='tab.create'){const w=workspaces.get(text(body.workspaceId,'workspaceId',128));if(!w)throw new BackendError('workspace_not_found','Workspace not found',404);const cwd=body.cwd?folder(text(body.cwd,'cwd')):w.cwd;const t=addTab(w,typeof body.label==='string'?text(body.label,'label',100):undefined);const p=spawnPane(t,cwd);return {tab:{tabId:t.id},pane:{paneId:p.id}};}
      const p=pane(body.paneId,text(body.identityToken,'identityToken',128));
      if(kind==='pane.split'){if(!['right','down'].includes(String(body.direction)))throw new BackendError('invalid_direction','Split must be right or down',400);const n=spawnPane(tabs.get(p.tabId)!,body.cwd?folder(text(body.cwd,'cwd')):workspaces.get(p.workspaceId)!.cwd);return {pane:{paneId:n.id}};}
      if(kind==='pane.close'){closePane(p,'pane_closed');return {closed:true};}
      // agent.start types the harness command into a terminal that is idle at its shell prompt.
      const harness=harnessByKind(text(body.kind,'agent kind',32));if(!harness)throw new BackendError('agent_kind_unsupported','Unknown agent kind',501);
      if(!available().includes(harness.kind))throw new BackendError('agent_not_installed','Install and configure this agent tool on the computer first',501);
      if(p.foreground?.pgid!==p.proc.pid)throw new BackendError('pane_busy','The terminal is running something else; start the agent from an idle shell',409);
      p.proc.terminal!.write(`${harness.command}\r`);return {pane:{paneId:p.id},agent:harness.kind};
    },
    close() {stopped=true;for(const p of [...panes.values()])closePane(p,'backend_closed');},
  };
}
