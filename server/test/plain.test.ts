import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,chmod,rm,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createPlainBackend} from '../src/backend/plain';
import type {HostBackend,TerminalFrame} from '../src/backend/types';
const cleanup:(()=>Promise<void>|void)[]=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
async function fixture(folders?:string[]) {
  const root=await mkdtemp(join(tmpdir(),'plain-backend-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'home'),bin=join(root,'bin'),state=join(root,'state');await mkdir(home);await mkdir(bin);await mkdir(state);
  // A stand-in agent: recognised by its executable name, does nothing but wait.
  await writeFile(join(bin,'opencode'),'#!/bin/sh\nprintf "AGENT_READY\\n"\nwhile :; do sleep 1; done\n');await chmod(join(bin,'opencode'),0o755);
  // A login shell rebuilds PATH from the system profile, so the fixture's own profile adds the stand-in back.
  await writeFile(join(home,'.profile'),`PATH="${bin}:$PATH"; export PATH; PS1='$ '\n`);
  const env={PATH:`${bin}:/usr/bin:/bin`,HOME:home,PS1:'$ ',ENV:''};
  const make=()=>{const b=createPlainBackend({stateDir:state,shell:'/bin/sh',folders:folders??[home],env});cleanup.push(()=>b.close());return b;};
  return {root,home,state,make};
}
const decode=(frames:TerminalFrame[])=>frames.map(f=>Buffer.from(f.bytes,'base64').toString()).join('');
async function until(check:()=>boolean|Promise<boolean>,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await Bun.sleep(25);}throw new Error('timed out');}
async function open(b:HostBackend,paneId:string,control=true,takeover=false) {
  const frames:TerminalFrame[]=[];let closed:string|undefined;
  const handle=await b.terminal({paneId,control,takeover,cols:80,rows:24,onFrame:f=>frames.push(f),onClose:r=>{closed=r;}});
  return {handle,frames,closed:()=>closed};
}
const first=async(b:HostBackend)=>((await b.snapshot()) as any).shellPanes[0];

test('starts a shell per chosen folder and remembers the folders',async()=>{
  const f=await fixture();const b=f.make();const s:any=await b.snapshot();
  expect(s.backend.kind).toBe('plain');expect(s.workspaces).toHaveLength(1);expect(s.shellPanes).toHaveLength(1);expect(s.agents).toHaveLength(0);
  expect(s.shellPanes[0].cwd).toBe(f.home);expect(s.capabilities.agentKinds).toContain('opencode');
  expect(JSON.parse(await readFile(join(f.state,'plain-workspaces.json'),'utf8')).folders.map((x:any)=>x.cwd)).toEqual([f.home]);
});

test('a controller types into the shell, observers only watch, and history reads the screen',async()=>{
  const f=await fixture();const b=f.make();const pane=await first(b);
  const control=await open(b,pane.paneId);expect(control.frames[0]!.full).toBe(true);
  const watcher=await open(b,pane.paneId,false);
  await control.handle.command({type:'terminal.input',text:"printf 'PLAIN_%s\\n' OK\r"});
  await until(()=>decode(watcher.frames).includes('PLAIN_OK'));
  expect(watcher.frames.slice(1).every((x,i)=>x.seq===watcher.frames[i]!.seq+1)).toBe(true);
  await expect(watcher.handle.command({type:'terminal.input',text:'x'})).rejects.toMatchObject({status:403});
  await expect(open(b,pane.paneId)).rejects.toMatchObject({status:409});
  const out:any=await b.output(undefined,pane.paneId,50);expect(out.text).toContain('PLAIN_OK');
});

test('resizing redraws for everyone at the new size; takeover closes the previous controller',async()=>{
  const f=await fixture();const b=f.make();const pane=await first(b);
  const control=await open(b,pane.paneId);
  await control.handle.command({type:'terminal.resize',cols:60,rows:20});
  expect(control.frames.at(-1)).toMatchObject({full:true,width:60,height:20});
  expect(await b.paneSize!(undefined,pane.paneId)).toEqual({cols:60,rows:20});
  const next=await open(b,pane.paneId,true,true);expect(control.closed()).toBe('control_taken_over');
  await next.handle.command({type:'terminal.input',text:"stty size\r"});await until(()=>decode(next.frames).includes('20 60'));
});

test('a running harness is recognised as an agent and changes the terminal identity',async()=>{
  const f=await fixture();const b=f.make();const pane=await first(b);
  await expect(b.mutate('agent.start',undefined,{paneId:pane.paneId,identityToken:pane.identityToken,kind:'nope'})).rejects.toMatchObject({status:501});
  await b.mutate('agent.start',undefined,{paneId:pane.paneId,identityToken:pane.identityToken,kind:'opencode'});
  await until(async()=>((await b.snapshot()) as any).agents.length===1);
  const agent=((await b.snapshot()) as any).agents[0];
  expect(agent.agent).toBe('opencode');expect(agent.identityToken).not.toBe(pane.identityToken);
  await expect(b.mutate('agent.start',undefined,{paneId:pane.paneId,identityToken:agent.identityToken,kind:'opencode'})).rejects.toMatchObject({status:409});
  await expect(b.submitText(undefined,pane.paneId,'hi',true,pane.identityToken)).rejects.toMatchObject({status:409});
});

test('workspaces, tabs, splits and closing follow the terminals that exist',async()=>{
  const f=await fixture();const b=f.make();const project=join(f.root,'project');await mkdir(project);
  await expect(b.mutate('workspace.create',undefined,{cwd:'relative'})).rejects.toMatchObject({status:400});
  await expect(b.mutate('workspace.create',undefined,{cwd:join(f.root,'missing')})).rejects.toMatchObject({status:400});
  const created:any=await b.mutate('workspace.create',undefined,{cwd:project,label:'Project'});
  await b.mutate('tab.create',undefined,{workspaceId:created.workspace.workspaceId});
  let s:any=await b.snapshot();const mine=s.shellPanes.filter((p:any)=>p.workspaceId===created.workspace.workspaceId);
  expect(mine).toHaveLength(2);expect(s.workspaces.find((w:any)=>w.label==='Project').tabCount).toBe(2);
  await b.mutate('pane.split',undefined,{paneId:mine[0].paneId,identityToken:mine[0].identityToken,direction:'right'});
  s=await b.snapshot();expect(s.shellPanes.filter((p:any)=>p.workspaceId===created.workspace.workspaceId)).toHaveLength(3);
  for(const p of s.shellPanes.filter((p:any)=>p.workspaceId===created.workspace.workspaceId))await b.mutate('pane.close',undefined,{paneId:p.paneId,identityToken:p.identityToken});
  s=await b.snapshot();expect(s.workspaces.map((w:any)=>w.label)).toEqual(['home']);
  expect(JSON.parse(await readFile(join(f.state,'plain-workspaces.json'),'utf8')).folders).toHaveLength(1);
});

test('a restarted bridge reopens the saved folders, and exited shells disappear',async()=>{
  const f=await fixture();const project=join(f.root,'project');await mkdir(project);
  const a=f.make();await a.mutate('workspace.create',undefined,{cwd:project});a.close();
  const b=f.make();const s:any=await b.snapshot();expect(s.workspaces.map((w:any)=>w.label).sort()).toEqual(['home','project']);
  const pane=s.shellPanes[0];const c=await open(b,pane.paneId);await c.handle.command({type:'terminal.input',text:'exit\r'});
  await until(()=>c.closed()==='session_closed');
  expect(((await b.snapshot()) as any).shellPanes).toHaveLength(1);
});

test('scrolling a shell shows its scrollback until new input; agent text is pasted then submitted',async()=>{
  const f=await fixture();const b=f.make();const pane=await first(b);const c=await open(b,pane.paneId);
  await c.handle.command({type:'terminal.input',text:"i=0; while [ $i -lt 80 ]; do echo row$i; i=$((i+1)); done\r"});
  await until(()=>decode(c.frames).includes('row79'));
  const before=c.frames.length;await c.handle.command({type:'terminal.scroll',direction:'up',lines:30});
  const scrolled=c.frames.slice(before).find(x=>x.full)!;expect(Buffer.from(scrolled.bytes,'base64').toString()).not.toContain('row79');
  await c.handle.command({type:'terminal.input',text:'\r'});
  expect(c.frames.slice(before+1).some(x=>x.full&&Buffer.from(x.bytes,'base64').toString().includes('row79'))).toBe(true);
  await c.handle.command({type:'terminal.input',text:"printf '\\033[?2004h'\r"});await Bun.sleep(200);
  const start=c.frames.length;await b.submitText(undefined,pane.paneId,'echo PASTED',true);
  await until(()=>decode(c.frames.slice(start)).includes('PASTED'));
});

test('an agent started in a plain terminal shows its own conversation history',async()=>{
  const f=await fixture();
  // A stand-in Codex in this folder, and its session log where Codex keeps them.
  await writeFile(join(f.root,'bin','codex'),'#!/bin/sh\nwhile :; do sleep 1; done\n');await chmod(join(f.root,'bin','codex'),0o755);
  const id='01a17891-280d-7c52-92e9-000000000001',dir=join(f.home,'.codex/sessions/2026/10/26');await mkdir(dir,{recursive:true});
  const line=(v:any)=>JSON.stringify(v)+'\n';
  await writeFile(join(dir,`rollout-2026-10-26T10-00-00-${id}.jsonl`),line({type:'session_meta',payload:{id,cwd:await realpath(f.home),source:'cli'}})
    +line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>x</environment_context>'},{type:'input_text',text:'Fix the build'}]}})
    +line({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixed.'}]}}));
  const b=f.make();const pane=await first(b);
  expect(((await b.snapshot()) as any).capabilities.transcript).toBe(true);
  await b.mutate('agent.start',undefined,{paneId:pane.paneId,identityToken:pane.identityToken,kind:'codex'});
  let agent:any;await until(async()=>!!(agent=((await b.snapshot()) as any).agents[0]));
  // The log was written before this stand-in started; touch it as a running agent would.
  await writeFile(join(dir,`rollout-2026-10-26T10-00-00-${id}.jsonl`),await readFile(join(dir,`rollout-2026-10-26T10-00-00-${id}.jsonl`)));
  const t:any=await b.transcript(undefined,agent.paneId,undefined,true);
  expect(t.supported).toBe(true);expect(t.messages.map((m:any)=>`${m.role}:${m.text}`)).toEqual(['user:Fix the build','assistant:Fixed.']);
});
