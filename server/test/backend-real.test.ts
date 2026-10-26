import {test,expect} from 'bun:test';
import {mkdtemp,rm,lstat} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createHerdrBackend} from '../src/backend';
/** Opt-in integration: only this fresh config directory and its own shell are ever controlled. */
test.skipIf(process.env.HERDR_REAL_TEST!=='1')('isolated installed Herdr shell output, observer, controller conflict and text admission',async()=>{
 expect(process.env.HERDR_ENV).toBe('1');
 const dir=await mkdtemp(join(tmpdir(),'herdr-mobile-real-'));const configDir=join(dir,'config','herdr');const socketPath=join(configDir,'herdr.sock');
 const env:NodeJS.ProcessEnv={...process.env,HERDR_CONFIG_PATH:join(configDir,'config.toml'),HERDR_SOCKET_PATH:socketPath,XDG_CONFIG_HOME:join(dir,'config'),XDG_STATE_HOME:join(dir,'state')};delete env.HERDR_SESSION;
 const herdr=Bun.which('herdr')!;const server=Bun.spawn([herdr,'server'],{env,cwd:dir,stdout:'ignore',stderr:'pipe'});
 const backend=createHerdrBackend({herdr,configDir,socketPath,epoch:'real-isolated'});
 const helpers:Array<{close():void}>=[];
 try {
  let ready=false;for(let i=0;i<80;i++){if(await lstat(socketPath).catch(()=>null)){ready=true;break;}await Bun.sleep(50);}expect(ready).toBe(true);
  // The headless server has no workspace until explicitly created by this test.
  const made:any=await backend.mutate('workspace.create',undefined,{cwd:dir,label:'Mobile isolated fixture'});
  let snapshot:any=await backend.snapshot();const paneId=made.root_pane?.pane_id??snapshot.shellPanes[0]?.paneId;expect(typeof paneId).toBe('string');
  // The PTY's real grid is read without resizing it; the observer uses it as its viewport.
  const size=await backend.paneSize!(undefined,paneId);expect(size.cols).toBeGreaterThanOrEqual(20);expect(size.rows).toBeGreaterThanOrEqual(5);
  const frames:any[]=[];let closeReason='';
  helpers.push(await backend.terminal({paneId,control:false,takeover:false,cols:80,rows:24,onFrame:f=>frames.push(f),onClose:r=>closeReason=r}));
  for(let i=0;i<60&&!frames.length;i++)await Bun.sleep(50);
  expect(frames.length).toBeGreaterThan(0);expect(frames[0].full).toBe(true);
  // Wait for the owned shell prompt to settle before typing a harmless built-in command.
  await Bun.sleep(500);const shellIdentity=await backend.identity(undefined,paneId);await backend.submitText(undefined,paneId,"printf 'HERDR_MOBILE_FIXTURE_OK\\n'",true);
  let output='';for(let i=0;i<60;i++){output=String((await backend.output(undefined,paneId,40)).text);if(output.includes('HERDR_MOBILE_FIXTURE_OK'))break;await Bun.sleep(50);}
  expect(output).toContain('HERDR_MOBILE_FIXTURE_OK');expect((await backend.identity(undefined,paneId)).identityToken).toBe(shellIdentity.identityToken);
  let aClosed='',bClosed='';const aFrames:any[]=[];
  helpers.push(await backend.terminal({paneId,control:true,takeover:false,cols:80,rows:24,onFrame:f=>aFrames.push(f),onClose:r=>aClosed=r}));
  for(let i=0;i<40&&!aFrames.length;i++)await Bun.sleep(50);expect(aFrames.length).toBeGreaterThan(0);
  await expect(backend.terminal({paneId,control:true,takeover:false,cols:80,rows:24,onFrame:()=>{},onClose:r=>bClosed=r})).rejects.toMatchObject({status:409});
  expect(bClosed).not.toBe('');expect(aClosed).toBe('');expect(closeReason).toBe('');
  snapshot=await backend.snapshot();expect(snapshot.shellPanes.some((p:any)=>p.paneId===paneId)).toBe(true);
 } finally {for(const h of helpers)h.close();backend.close();const stop=Bun.spawn([herdr,'server','stop'],{env,stdout:'ignore',stderr:'ignore'});await stop.exited;await server.exited;await rm(dir,{recursive:true,force:true});}
},20000);
