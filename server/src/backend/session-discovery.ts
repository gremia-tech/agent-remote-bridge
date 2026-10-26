import { open, readdir, readlink, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { harnessFor } from './harnesses';
import { normalizeTranscriptRecord, type NativeSession } from './transcripts';

/** A pane's foreground program as the multiplexer (or the plain backend) reports it. argv is only
 *  inspected here, never reported. */
export interface AgentProcess {pid:number;cwd?:string;argv?:string[];name?:string}
export interface DiscoveryRoots {codex:string;claude:string}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Elapsed time from `ps -o etime=`: [[dd-]hh:]mm:ss. */
export function parseElapsed(value:string):number|undefined {
  const m=value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);if(!m)return;
  return ((Number(m[1]??0)*24+Number(m[2]??0))*60+Number(m[3]))*60+Number(m[4]);
}
async function startedAt(pid:number):Promise<number|undefined> {
  try{const p=Bun.spawn(['ps','-o','etime=','-p',String(pid)],{stdout:'pipe',stderr:'ignore'});const out=await new Response(p.stdout).text();await p.exited;
    const s=parseElapsed(out);return s===undefined?undefined:Date.now()-s*1000;}catch{return;}
}
/** A process's working folder: /proc on Linux, lsof elsewhere (macOS). */
export async function processCwd(pid:number):Promise<string|undefined> {
  const linux=await readlink(`/proc/${pid}/cwd`).catch(()=>undefined);if(linux)return linux;
  try{const p=Bun.spawn(['lsof','-a','-p',String(pid),'-d','cwd','-Fn'],{stdout:'pipe',stderr:'ignore'});const out=await new Response(p.stdout).text();await p.exited;
    return out.split('\n').find(l=>l.startsWith('n/'))?.slice(1);}catch{return;}
}
/** A session id the user passed on the command line (`codex resume <id>`, `claude --resume <id>`). */
export function sessionFromArgs(agent:string,argv:string[]):string|undefined {
  for(let i=1;i<argv.length-1;i++){
    const flag=argv[i]!,value=argv[i+1]!;
    if(agent==='codex'&&flag==='resume'&&UUID.test(value))return value;
    if(agent==='claude'&&['--resume','-r','--session-id'].includes(flag)&&UUID.test(value))return value;
  }
  for(const arg of argv)if(agent==='claude'){const m=arg.match(/^--(?:resume|session-id)=(.+)$/);if(m&&UUID.test(m[1]!))return m[1];}
  return undefined;
}
async function firstLine(path:string,limit=256*1024):Promise<any> {
  const handle=await open(path,'r').catch(()=>null);if(!handle)return;
  try{const buf=Buffer.alloc(limit);const r=await handle.read(buf,0,limit,0);const data=buf.subarray(0,r.bytesRead);const nl=data.indexOf(10);
    return JSON.parse(data.subarray(0,nl<0?data.length:nl).toString('utf8'));}catch{return;}finally{await handle.close();}
}
interface Candidate {id:string;path:string}
/** Interactive Codex sessions (not guardian reviews, exec runs or spawned sub-agents) in `cwd`, written since `since`. */
export async function codexCandidates(root:string,cwd:string,since:number):Promise<Candidate[]> {
  const found:Candidate[]=[];let budget=20000;
  async function walk(dir:string,depth:number){
    if(depth>4)return;
    for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])){
      if(--budget<0)return;
      const path=join(dir,entry.name);
      if(entry.isDirectory()){await walk(path,depth+1);continue;}
      if(!entry.isFile()||!entry.name.startsWith('rollout-')||!entry.name.endsWith('.jsonl'))continue;
      if(((await stat(path).catch(()=>null))?.mtimeMs??0)<since)continue;
      const meta=await firstLine(path);const p=meta?.type==='session_meta'?meta.payload:undefined;
      if(!p||p.cwd!==cwd||typeof p.id!=='string'||typeof p.source!=='string'||p.source==='exec'||p.thread_source==='guardian_review')continue;
      found.push({id:p.id,path});
    }
  }
  await walk(root,0);return found;
}
/** Claude keeps each project's sessions in projects/<cwd with every non-alphanumeric as '-'>/<id>.jsonl. */
async function claudeCandidates(root:string,cwd:string,since:number):Promise<Candidate[]> {
  const dir=join(root,cwd.replace(/[^A-Za-z0-9]/g,'-'));const found:Candidate[]=[];
  for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])){
    const id=entry.name.replace(/\.jsonl$/,'');
    if(!entry.isFile()||id===entry.name||!UUID.test(id))continue;
    const path=join(dir,entry.name),info=await stat(path).catch(()=>null);
    if(info&&info.mtimeMs>=since)found.push({id,path});
  }
  return found;
}
/** Codex titles its terminal "<thread name> | <folder>" and keeps thread names in session_index.jsonl
 *  next to sessions/ (newest line per id wins, so renames count). Returns the ids currently named as
 *  the title says. */
export async function codexThreadsNamed(sessionsRoot:string,title:string,cwd?:string):Promise<string[]> {
  let name=title.replace(/^[^\p{L}\p{N}]+/u,'').trim();
  const folder=cwd?basename(cwd):undefined;
  if(folder&&name.endsWith(` | ${folder}`))name=name.slice(0,-folder.length-3).trim();
  if(name.length<3)return [];
  const handle=await open(join(dirname(sessionsRoot),'session_index.jsonl'),'r').catch(()=>null);if(!handle)return [];
  try{
    const size=(await handle.stat()).size,length=Math.min(size,8*1024*1024);const buf=Buffer.alloc(length);await handle.read(buf,0,length,size-length);
    const names=new Map<string,string>();
    for(const line of buf.toString('utf8').split('\n')){try{const r=JSON.parse(line);if(typeof r?.id==='string'&&typeof r?.thread_name==='string')names.set(r.id,r.thread_name);}catch{}}
    return [...names].filter(([,n])=>n===name).map(([id])=>id);
  }finally{await handle.close();}
}
// Agents render Markdown links as "text (url)" or just text, so links and URLs are compared as their text.
const plain=(t:string)=>t.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\[([^\]\n]*)\]\([^)\n]*\)/g,'$1').replace(/\(?https?:\/\/[^\s)]*\)?/g,'').replace(/[*`#>|\u2500-\u257f]/g,'').replace(/\s+/g,' ').toLowerCase();
/** Phrases from the newest things said in a session, for matching against what its pane shows. */
export async function recentPhrases(path:string,agent:string):Promise<string[]> {
  const handle=await open(path,'r').catch(()=>null);if(!handle)return [];
  try{
    const size=(await handle.stat()).size,length=Math.min(size,1024*1024);const buf=Buffer.alloc(length);await handle.read(buf,0,length,size-length);
    const said:string[]=[];
    for(const line of buf.toString('utf8').split('\n').slice(size>length?1:0).reverse()){
      let row;try{row=JSON.parse(line);}catch{continue;}
      for(const m of normalizeTranscriptRecord(agent,row,'x').reverse())if(m.kind==='message')said.push(m.text);
      if(said.length>=12)break;
    }
    const phrases:string[]=[];
    for(const text of said)for(const line of text.split('\n')){const p=plain(line).trim();if(p.length>=28)phrases.push(p.slice(0,28));}
    return phrases.slice(0,60);
  }finally{await handle.close();}
}
/** When the multiplexer has no session reference for an agent pane, find the agent's own log on this
 *  computer: an id on its command line, otherwise an interactive session in the pane's folder written
 *  since the program started. Several of those (other agents in the same folder, resumed sessions) are
 *  told apart by what the pane is showing; anything still ambiguous finds nothing rather than a
 *  neighbour's conversation. */
export async function discoverSession(agent:string,processes:AgentProcess[],roots:DiscoveryRoots,options:{claimed:Set<string>;sharedFolder:boolean;title?:string;screen?:()=>Promise<string>}):Promise<NativeSession|undefined> {
  if(agent!=='codex'&&agent!=='claude')return;
  const proc=processes.find(p=>harnessFor(p.name??'',p.argv??[])?.kind===agent);if(!proc)return;
  const ref=(value:string):NativeSession=>({source:`herdr:${agent}`,agent,kind:'id',value});
  const fromArgs=sessionFromArgs(agent,proc.argv??[]);if(fromArgs)return ref(fromArgs);
  if(!proc.cwd)return;
  const start=await startedAt(proc.pid);if(start===undefined)return;
  const since=start-5000;
  // A session another pane already shows still counts when this pane's screen matches it: Codex lets
  // several terminals open the same thread.
  const all=agent==='codex'?await codexCandidates(roots.codex,proc.cwd,since):await claudeCandidates(roots.claude,proc.cwd,since);
  // The thread name in the title is the best evidence: one thread with that name is the one shown,
  // whichever folder it was started in.
  if(agent==='codex'&&options.title){
    const named=await codexThreadsNamed(roots.codex,options.title,proc.cwd);
    if(named.length===1)return ref(named[0]!);
    const local=all.filter(c=>named.includes(c.id));if(local.length===1)return ref(local[0]!.id);
  }
  const unclaimed=all.filter(c=>!options.claimed.has(c.id));
  if(unclaimed.length===1&&all.length===1&&!options.sharedFolder)return ref(unclaimed[0]!.id);
  if(!all.length||all.length>24||!options.screen)return;
  const raw=await options.screen().catch(()=>'');
  // Codex's /status panel prints the session id (wrapped across lines).
  const compact=raw.replace(/\s+/g,'');const shown=all.filter(c=>compact.includes(c.id));if(shown.length===1)return ref(shown[0]!.id);
  const screen=plain(raw);if(screen.length<40)return;
  const scored=await Promise.all(all.map(async c=>({c,score:(await recentPhrases(c.path,agent)).filter(p=>screen.includes(p)).length})));
  scored.sort((a,b)=>b.score-a.score);
  const [best,next]=scored;
  return best&&best.score>=(all.length===1?1:2)&&best.score>=2*(next?.score??0)?ref(best.c.id):undefined;
}
