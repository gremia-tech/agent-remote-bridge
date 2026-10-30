/** Terminal coding agents the bridge can recognise and start. `kind` is Herdr's canonical label
 *  (research/sources/herdr src/detect/mod.rs) so both backends agree; `command` is what a shell
 *  runs; `names` are executable names a running agent shows as its foreground process.
 *  `herdr` marks kinds Herdr's own agent.start accepts. */
export interface Harness {kind:string;label:string;command:string;names:string[];herdr:boolean}
const h=(kind:string,label:string,command:string,names:string[]=[command],herdr=true):Harness=>({kind,label,command,names,herdr});
export const HARNESSES:Harness[]=[
  h('claude','Claude Code','claude',['claude','claude-code']),
  h('codex','Codex','codex'),
  h('opencode','OpenCode','opencode',['opencode','opencode2']),
  h('pi','Pi','pi'),
  h('gemini','Gemini CLI','gemini'),
  h('qwen','Qwen Code','qwen',['qwen','qwen-code']),
  h('kimi','Kimi Code','kimi',['kimi','kimi-code']),
  h('copilot','GitHub Copilot CLI','copilot',['copilot','github-copilot']),
  h('cursor','Cursor CLI','cursor-agent',['cursor-agent']),
  h('droid','Droid','droid'),
  h('amp','Amp','amp',['amp','amp-local']),
  h('kiro','Kiro CLI','kiro-cli',['kiro-cli']),
  h('cline','Cline','cline'),
  h('kilo','Kilo Code','kilo',['kilo','kilo-code']),
  h('qodercli','Qoder CLI','qodercli',['qodercli','qoder']),
  h('devin','Devin CLI','devin',['devin','devin-cli']),
  h('agy','Antigravity CLI','agy',['agy','antigravity','antigravity-cli']),
  h('grok','Grok CLI','grok',['grok','grok-build']),
  h('hermes','Hermes Agent','hermes',['hermes','hermes-agent']),
  h('omp','Oh My Pi','omp'),
  h('mastracode','Mastra Code','mastracode',['mastracode','mastra-code']),
  h('letta','Letta Code','letta',['letta','letta-code']),
  h('maki','Maki','maki'),
  h('muse','Muse','muse',['muse','muse-code','muse-cli']),
  // Not known to Herdr: plain terminals can start and recognise them.
  h('crush','Crush','crush',['crush'],false),
  h('goose','Goose','goose',['goose'],false),
  h('aider','Aider','aider',['aider'],false),
  h('auggie','Auggie','auggie',['auggie'],false),
  h('codebuddy','CodeBuddy','codebuddy',['codebuddy'],false),
  h('zcode','ZCode (Z.ai)','zcode',['zcode'],false),
  h('dsh','DeepSeek Harness','dsh',['dsh','dsh-tui'],false),
];
const byName=new Map(HARNESSES.flatMap(x=>x.names.map(n=>[n,x] as const)));
const interpreters=new Set(['node','bun','deno','python','python3','uv']);
const base=(path:string)=>path.slice(path.lastIndexOf('/')+1);
/** Identify a harness from a process's executable and arguments. Script runtimes (node, python…)
 *  are looked through to the script they run. Arguments are only inspected, never reported. */
export function harnessFor(comm:string,args:string[]):Harness|undefined {
  const exe=base(args[0]??comm);
  const direct=byName.get(base(comm))??byName.get(exe);
  if(direct)return direct;
  if(interpreters.has(exe)||interpreters.has(base(comm)))for(const arg of args.slice(1,4)){if(arg.startsWith('-'))continue;const hit=byName.get(base(arg).replace(/\.(m?js|py)$/,''));if(hit)return hit;break;}
  return undefined;
}
export const harnessByKind=(kind:string)=>HARNESSES.find(x=>x.kind===kind);
const installedCache=new Map<string,{at:number;value:Harness[]}>();
/** Harnesses whose start command is on this computer's PATH (plus common per-user install folders).
 *  Every snapshot asks, and a search stats each folder for each harness, so the answer is kept for 30 s. */
export function installedHarnesses(path=process.env.PATH,home=process.env.HOME??''):Harness[] {
  const search=[path,`${home}/.local/bin`,`${home}/.bun/bin`,`${home}/.npm-global/bin`,`${home}/.opencode/bin`,'/opt/homebrew/bin','/usr/local/bin'].filter(Boolean).join(':');
  const cached=installedCache.get(search),now=Date.now();
  if(cached&&now-cached.at<30_000)return cached.value;
  const value=HARNESSES.filter(x=>Bun.which(x.command,{PATH:search}));
  if(installedCache.size>=16)installedCache.clear();
  installedCache.set(search,{at:now,value});
  return value;
}
