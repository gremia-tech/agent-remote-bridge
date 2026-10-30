import { constants } from 'node:fs';
import { open, readdir, realpath, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { TranscriptMessage } from './types';
export interface NativeSession {source:string;agent:string;kind:string;value:string}
// Long-running sessions grow without bound; reads are paged and tails scan at most TAIL_SCAN.
const MAX_HISTORY=4*1024*1024*1024;
const PREFIX_FULL = 8*1024*1024, PAGE = 2*1024*1024, MAX_TEXT = 32*1024, MAX_MESSAGES=200;
// Tail reads look this far back for MAX_MESSAGES things the user or agent said; tool calls and
// their output come along trimmed to TAIL_TOOL_TEXT and never count toward the limit.
const TAIL_SCAN = 16*1024*1024, TAIL_TOOL_TEXT = 2048, MAX_RESPONSE_BYTES = 1_000_000;
const spoken=(m:TranscriptMessage)=>m.kind==='message'&&(m.role==='user'||m.role==='assistant');
const trimText=(value:string,limit=MAX_TEXT)=>{const bytes=Buffer.from(value);if(bytes.length<=limit)return value;let cut=limit;while((bytes[cut]!&0xc0)===0x80)cut--;return bytes.subarray(0,cut).toString('utf8');};
const digest = (value: string|Buffer) => createHash('sha256').update(value).digest('hex');
const text = (value:any):string => trimText(typeof value === 'string' ? value : Array.isArray(value) ? value.filter(x => x?.type === 'text' || x?.type === 'input_text' || x?.type === 'output_text').map(x=>x.text ?? '').join('\n') : '');
const tag=(t:string,name:string)=>t.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()??'';
/** What the user actually typed in a user turn. Harnesses also put their own instructions, environment
 *  and status blocks there (`<environment_context>`, `# AGENTS.md instructions`, `<task-notification>`…);
 *  those are dropped or shown as a short notice, never as something the user said. */
function userTurn(t:string):{kind:'message'|'notice'|'tool_result';text:string}|undefined {
  t=t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,'').trim();
  if(!t)return;
  if(t.startsWith('<send_user_message_question_reply>')) {
    try{const answers=JSON.parse(t.replace(/<\/?send_user_message_question_reply>/g,'').trim().replace(/^user:\s*/,''));
      const text=(Array.isArray(answers)?answers:[]).map((a:any)=>typeof a?.answer==='string'?a.answer:'').filter(Boolean).join('\n');
      return text?{kind:'message',text}:undefined;}
    catch{const text=[...t.matchAll(/"answer":"((?:[^"\\]|\\.)*)"/g)].map(m=>{try{return JSON.parse(`"${m[1]}"`) as string;}catch{return '';}}).filter(Boolean).join('\n');return text?{kind:'message',text}:undefined;}
  }
  if(t.startsWith('<command-name>'))return {kind:'message',text:[tag(t,'command-name'),tag(t,'command-args')].filter(Boolean).join(' ')};
  if(t.startsWith('<local-command-stdout>')){const out=tag(t,'local-command-stdout');return out?{kind:'tool_result',text:out}:undefined;}
  if(t.startsWith('<task-notification>'))return {kind:'notice',text:tag(t,'summary')||'Background task finished'};
  if(t.startsWith('<turn_aborted>')||t.startsWith('[Request interrupted'))return {kind:'notice',text:'Interrupted'};
  if(/^(<[a-z][a-z0-9]*(?:[_ -][a-z0-9]+)+>|# AGENTS\.md instructions)/.test(t))return;
  return {kind:'message',text:t};
}
/** Allowlist published content. Reasoning/thinking, system prompts, internal events are never projected. */
export function normalizeTranscriptRecord(agent:string, row:any, lineId:string):TranscriptMessage[] {
  const result:TranscriptMessage[]=[];
  const add=(role:TranscriptMessage['role'],kind:TranscriptMessage['kind'],value:string, toolName?:string,id?:string) => {
    if(value&&result.length<=MAX_MESSAGES) result.push({id:id ?? `${lineId}:${result.length}`,role,kind,text:trimText(value),...(typeof row.timestamp==='string'?{timestamp:row.timestamp}:{}),...(toolName?{toolName}:{})});
  };
  const said=(value:string,id?:string)=>{const turn=userTurn(value);if(!turn)return;if(turn.kind==='message')add('user','message',turn.text,undefined,id);else if(turn.kind==='notice')add('system','notice',turn.text,undefined,id);else add('tool','tool_result',turn.text,'command',id);};
  if(agent==='codex' && row.type==='response_item') {
    const p=row.payload;
    if(p?.type==='message' && p.role==='user' && Array.isArray(p.content)) for(const part of p.content){if(part?.type==='input_text'&&typeof part.text==='string')said(part.text);}
    if(p?.type==='message' && p.role==='assistant' && (p.channel==null||['final','commentary'].includes(p.channel))) add(p.role,'message',text(p.content),undefined,p.id);
    if(p?.type==='function_call' || p?.type==='custom_tool_call') add('assistant','tool_call',text(p.arguments ?? p.input),String(p.name ?? 'tool'),p.call_id ? `${p.call_id}:call` : undefined);
    if(p?.type==='function_call_output' || p?.type==='custom_tool_call_output') add('tool','tool_result',text(p.output),undefined,p.call_id ? `${p.call_id}:result`:undefined);
  }
  if(agent==='claude' && !row.isMeta && !row.isCompactSummary && ['user','assistant'].includes(row.type) && row.message) {
    const content=row.message.content;
    if(typeof content==='string') {if(row.type==='user')said(content,row.uuid);else add(row.type,'message',content,undefined,row.uuid);}
    else if(Array.isArray(content)) for(const p of content) {
      if(p?.type==='text') {if(row.type==='user')said(text(p.text));else add(row.type,'message',text(p.text));}
      if(p?.type==='tool_use') add('assistant','tool_call',trimText(JSON.stringify(p.input ?? {})),String(p.name ?? 'tool'),p.id ? `${p.id}:call`:undefined);
      if(p?.type==='tool_result') add('tool','tool_result',text(p.content),undefined,p.tool_use_id ? `${p.tool_use_id}:result`:undefined);
    }
  }
  if(agent==='pi' && row.type==='message' && row.message) {
    // Pi (docs/session-format.md, message-types.md): user/assistant/toolResult messages; thinking is never shown.
    const m=row.message;
    if(m.role==='user'||m.role==='assistant') {
      if(typeof m.content==='string')add(m.role,'message',m.content,undefined,row.id);
      else if(Array.isArray(m.content)) for(const p of m.content) {
        if(p?.type==='text')add(m.role,'message',text(p.text));
        if(p?.type==='toolCall'&&m.role==='assistant')add('assistant','tool_call',trimText(JSON.stringify(p.arguments??{})),String(p.name??'tool'),p.id?`${p.id}:call`:undefined);
      }
    }
    if(m.role==='toolResult')add('tool','tool_result',text(m.content),typeof m.toolName==='string'?m.toolName:undefined,m.toolCallId?`${m.toolCallId}:result`:undefined);
  }
  if(agent==='qwen' && ['user','assistant','tool_result'].includes(row.type) && Array.isArray(row.message?.parts)) {
    // Qwen Code chat records carry Gemini Content parts; `thought` parts are reasoning and stay hidden.
    const role=row.type==='assistant'?'assistant':'user';
    for(const p of row.message.parts) {
      if(typeof p?.text==='string'&&!p.thought&&row.type!=='tool_result')add(role,'message',p.text);
      if(p?.functionCall)add('assistant','tool_call',trimText(JSON.stringify(p.functionCall.args??{})),String(p.functionCall.name??'tool'),p.functionCall.id?`${p.functionCall.id}:call`:undefined);
      if(p?.functionResponse){const r=p.functionResponse.response;add('tool','tool_result',typeof r?.output==='string'?r.output:typeof r?.error==='string'?r.error:trimText(JSON.stringify(r??{})),String(p.functionResponse.name??'tool'),p.functionResponse.id?`${p.functionResponse.id}:result`:undefined);}
    }
  }
  return result;
}
const contained=(root:string,path:string)=>{ const p=relative(root,path); return p!=='' && !p.startsWith('../') && !isAbsolute(p); };
/** Search filenames only beneath the agent's documented storage root; never infer sessions from cwd. */
async function locate(root:string, ref:NativeSession):Promise<string|null> {
  const base=await realpath(root).catch(()=>null); if(!base)return null;
  if(ref.kind==='path') {
    const candidate=await realpath(ref.value).catch(()=>null);
    return candidate && contained(base,candidate) && candidate.endsWith('.jsonl') ? candidate : null;
  }
  if(ref.kind!=='id'||!/^[A-Za-z0-9_-]{1,128}$/.test(ref.value))return null;
  // Claude keeps sessions at projects/<cwd>/<id>.jsonl: check that shape directly so a large
  // projects folder (subagent logs, many sessions) cannot exhaust the walk below.
  const direct:string[]=[];
  for(const entry of await readdir(base,{withFileTypes:true}).catch(()=>[])) {
    if(!entry.isDirectory())continue;
    const candidate=join(base,entry.name,`${ref.value}.jsonl`);
    if((await lstat(candidate).catch(()=>null))?.isFile())direct.push(candidate);
    if(direct.length>1)return null;
  }
  if(direct.length===1)return direct[0]!;
  let budget=6000; const matches:string[]=[];
  async function walk(dir:string,depth:number) {
    if(depth>5||budget<=0)return;
    for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])) {
      if(--budget<0)return;
      const path=join(dir,entry.name);
      if(entry.isDirectory())await walk(path,depth+1);
      else if(entry.isFile()&&(entry.name===`${ref.value}.jsonl`||entry.name.endsWith(`-${ref.value}.jsonl`)))matches.push(path);
      if(matches.length>1)return;
    }
  }
  await walk(base,0);
  if(matches.length!==1||budget<=0)return null;
  return matches[0]!;
}
/** Where each supported agent keeps its session logs, relative to home (overridable per agent). */
const STORAGE={claude:'.claude/projects',codex:'.codex/sessions',pi:'.pi/agent/sessions',qwen:'.qwen/projects'} as const;
export type TranscriptRoots=Partial<Record<keyof typeof STORAGE,string>>;
interface Cursor {v:1;binding:string;file:string;offset:number;prefix:string;drop?:boolean}
/** Marks where a page read backwards began, so the next page back ends there. The prefix hash proves the log before it is unchanged. */
interface Earlier {v:1;binding:string;file:string;before:number;prefix:string}
/** `tail` (without a cursor) starts from the newest records instead of the session start; a string is an
 *  `earlier` value from a previous tail page and reads the page before it. */
export async function readTranscript(home:string, native:NativeSession|undefined, identityToken:string,cursor?:string,roots?:TranscriptRoots,tail:boolean|string=false):Promise<Record<string,unknown>> {
  const none=(reason:string)=>({source:native?.agent ?? null,supported:false,reason,messages:[],cursor:null,reset:!!cursor,truncated:false,hasMore:false});
  if(!native||!(native.agent in STORAGE)||native.source!==`herdr:${native.agent}`)return none('native_session_unavailable');
  const root=roots?.[native.agent as keyof typeof STORAGE]??join(home,STORAGE[native.agent as keyof typeof STORAGE]);
  const path=await locate(root,native); if(!path)return none('session_file_missing_or_ambiguous');
  const canonical=await realpath(path).catch(()=>null); const base=await realpath(root).catch(()=>null);
  if(!canonical||!base||!contained(base,canonical))return none('session_file_outside_root');
  const expected=await lstat(canonical).catch(()=>null);if(!expected?.isFile())return none('session_file_unavailable');
  let handle;
  try {handle=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{return none('session_file_unavailable');}
  try {
    const stat=await handle.stat(); if(!stat.isFile()||stat.dev!==expected.dev||stat.ino!==expected.ino||await realpath(canonical).catch(()=>null)!==canonical)return none('session_file_changed');
    if(stat.size>MAX_HISTORY)return none('session_file_limit');
    // The cursor proves the read prefix is unchanged. Past PREFIX_FULL only its start and the part just
    // before the cursor are hashed, so polling a very long session stays cheap.
    const prefixHash=async(length:number)=>{const hash=createHash('sha256');const buf=Buffer.alloc(Math.min(PAGE,length));
      const ranges=length<=PREFIX_FULL?[[0,length]]:[[0,PREFIX_FULL/2],[length-PREFIX_FULL/2,length]];
      for(const [from,to] of ranges)for(let at=from!;at<to!;){const r=await handle.read(buf,0,Math.min(buf.length,to!-at),at);if(!r.bytesRead)return '';hash.update(buf.subarray(0,r.bytesRead));at+=r.bytesRead;}
      if(length>PREFIX_FULL)hash.update(String(length));return hash.digest('hex');};
    const header=Buffer.alloc(Math.min(65536,stat.size));await handle.read(header,0,header.length,0);
    let nativeId:string|undefined;
    for(const line of header.toString().split('\n').slice(0,-1)) {try{const r=JSON.parse(line);if(native.agent==='codex'&&r.type==='session_meta')nativeId=r.payload?.id; if((native.agent==='claude'||native.agent==='qwen')&&typeof r.sessionId==='string')nativeId=r.sessionId; if(native.agent==='pi'&&r.type==='session'&&typeof r.id==='string')nativeId=r.id;if(nativeId)break;}catch{}}
    if(!nativeId || (native.kind==='id'&&nativeId!==native.value))return none('session_metadata_mismatch');
    const binding=digest(identityToken+'\0'+native.source+'\0'+native.agent+'\0'+nativeId);
    const file=`${stat.dev}:${stat.ino}`;
    let offset=0,reset=!!cursor,drop=false;
    if(cursor&&cursor.length<=2048)try {
      const c=JSON.parse(Buffer.from(cursor,'base64url').toString()) as Cursor;
      if(c.v===1&&c.binding===binding&&c.file===file&&Number.isSafeInteger(c.offset)&&c.offset>=0&&c.offset<=stat.size) {
        if(await prefixHash(c.offset)===c.prefix){offset=c.offset;drop=!!c.drop;reset=false;}
      }
    }catch{}
    const messages:TranscriptMessage[]=[];let truncated=false;let pending=false;let unread=false;
    let earlier:string|null=null;
    if(typeof tail==='string'||(tail&&!cursor)) {
      // A tail reads back from the end of the log; `earlier` (a string) reads back from where a previous page began.
      let endAt=stat.size;
      if(typeof tail==='string') {
        let c:Earlier|undefined;try{c=JSON.parse(Buffer.from(tail.slice(0,2048),'base64url').toString()) as Earlier;}catch{}
        if(!c||c.v!==1||c.binding!==binding||c.file!==file||!Number.isSafeInteger(c.before)||c.before<=0||c.before>stat.size||await prefixHash(c.before)!==c.prefix)
          return {source:native.agent,supported:true,messages:[],cursor:null,earlier:null,reset:true,truncated:false,hasMore:false};
        endAt=c.before;
      }
      // Read whole lines backwards until enough has been said.
      const records:{start:number;messages:TranscriptMessage[]}[]=[];let said=0,pos=endAt,end=-1,e=0;let buf=Buffer.alloc(0);
      while(said<MAX_MESSAGES) {
        if(pos>0&&endAt-pos<TAIL_SCAN){const size=Math.min(PAGE,pos);pos-=size;const chunk=Buffer.alloc(size);const r=await handle.read(chunk,0,size,pos);buf=Buffer.concat([chunk.subarray(0,r.bytesRead),buf.subarray(0,e)]);e=buf.length;}
        else if(pos>0)break;
        if(end<0){const nl=buf.lastIndexOf(10);if(nl<0){if(pos===0)break;continue;}pending=nl+1<buf.length;end=pos+nl+1;e=nl+1;}
        while(e>0&&said<MAX_MESSAGES) {
          const nl=e>=2?buf.lastIndexOf(10,e-2):-1;
          if(nl<0&&pos>0)break;
          const start=nl+1,line=buf.subarray(start,e-1);e=start;
          if(line.length>256*1024){truncated=true;continue;}
          try {
            const row=JSON.parse(line.toString('utf8'));
            if((native.agent==='claude'||native.agent==='qwen')&&row.sessionId&&row.sessionId!==nativeId)continue;
            const normalized=normalizeTranscriptRecord(native.agent,row,`${nativeId}:${pos+start}`)
              .map(m=>spoken(m)?m:{...m,text:trimText(m.text,TAIL_TOOL_TEXT)});
            if(normalized.length){records.push({start:pos+start,messages:normalized});said+=normalized.filter(spoken).length;}
          }catch{}
        }
        if(pos===0&&e===0)break;
      }
      records.reverse();
      // Over the response budget, shorten the oldest tool activity first; drop whole records only as a last resort.
      let bytes=records.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r.messages)),0);
      for(const r of records)for(let i=0;i<r.messages.length&&bytes>MAX_RESPONSE_BYTES;i++){const m=r.messages[i]!;if(spoken(m))continue;const short=trimText(m.text.split('\n',1)[0]!,160);bytes-=Buffer.byteLength(m.text)-Buffer.byteLength(short);r.messages[i]={...m,text:short};}
      let dropped=false;
      while(records.length>1&&bytes>MAX_RESPONSE_BYTES){bytes-=Buffer.byteLength(JSON.stringify(records.shift()!.messages));dropped=true;}
      for(const r of records)messages.push(...r.messages);
      // Where the next page back ends: the first record kept, or the earliest line looked at.
      const from=dropped?records[0]!.start:pos+e;
      if(from>0&&from<endAt)earlier=Buffer.from(JSON.stringify({v:1,binding,file,before:from,prefix:await prefixHash(from)} satisfies Earlier)).toString('base64url');
      truncated||=from>0;
      if(typeof tail==='string'){const after=await handle.stat();if(after.size<stat.size||(after.mtimeMs!==stat.mtimeMs&&after.size<=stat.size))return none('session_file_changed_during_read');
        return {source:native.agent,supported:true,messages,cursor:null,earlier,reset:false,truncated,hasMore:earlier!==null};}
      offset=Math.max(end,0);
    } else {
      const bytes=Buffer.alloc(Math.min(PAGE,stat.size-offset)); const read=await handle.read(bytes,0,bytes.length,offset);const data=bytes.subarray(0,read.bytesRead);
      let consumed=0;let resultBytes=0;
      while(consumed<data.length) {
        const nl=data.indexOf(10,consumed);
        if(nl<0){if(data.length-consumed>=256*1024){consumed=data.length;drop=true;truncated=true;}else pending=true;break;}
        const start=consumed;consumed=nl+1;
        if(drop){drop=false;continue;}
        if(nl-start>256*1024){truncated=true;continue;}
        try {
          const row=JSON.parse(data.subarray(start,nl).toString('utf8'));
          if((native.agent==='claude'||native.agent==='qwen')&&row.sessionId&&row.sessionId!==nativeId)continue;
          const normalized=normalizeTranscriptRecord(native.agent,row,`${nativeId}:${offset+start}`);
          const recordBytes=Buffer.byteLength(JSON.stringify(normalized));
          if(messages.length&&resultBytes+recordBytes>MAX_RESPONSE_BYTES){consumed=start;truncated=true;break;}
          resultBytes+=recordBytes;
          if(normalized.length>MAX_MESSAGES){if(messages.length){consumed=start;truncated=true;break;}messages.push(...normalized.slice(0,MAX_MESSAGES-1),{id:`${nativeId}:${offset+start}:limit`,role:'system',kind:'notice',text:'Additional content in this oversized log record was omitted.'});truncated=true;break;}
          if(messages.length+normalized.length>MAX_MESSAGES){consumed=start;truncated=true;break;}
          messages.push(...normalized);
        }catch{/* Ignore malformed complete records, leave incomplete final lines for the next poll. */}
      }
      unread=offset+data.length<stat.size;
      offset+=consumed;
    }
    const end=await handle.stat();
    // Appends are allowed; truncation or same-size rewrites during this read require a fresh request.
    if(end.size<stat.size||(end.mtimeMs!==stat.mtimeMs&&end.size<=stat.size))return none('session_file_changed_during_read');
    const next:Cursor={v:1,binding,file,offset,prefix:await prefixHash(offset),...(drop?{drop:true}:{})};
    return {source:native.agent,supported:true,messages,cursor:Buffer.from(JSON.stringify(next)).toString('base64url'),...(tail&&!cursor?{earlier}:{}),reset,truncated:truncated||unread,hasMore:truncated||unread,...(pending?{pending:true}:{})};
  } finally {await handle.close();}
}
