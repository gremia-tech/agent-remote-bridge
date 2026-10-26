import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { BackendError, type TerminalHandle, type TerminalFrame } from './types';
import { compactFrame } from './compact-ansi';
export interface TerminalOptions {
  herdr: string; session: string; configDir: string; socketPath?: string; paneId: string; identityToken: string;
  control: boolean; takeover: boolean; cols: number; rows: number;
  onFrame(frame: TerminalFrame): void; onClose(reason: string): void;
}
export function terminalArgs(o: TerminalOptions): string[] {
  return [...(o.socketPath || o.session === 'default' ? [] : ['--session', o.session]), 'terminal', 'session', o.control ? 'control' : 'observe', o.paneId,
    ...(o.control && o.takeover ? ['--takeover'] : []), '--cols', String(o.cols), '--rows', String(o.rows)];
}
export async function openTerminal(o: TerminalOptions): Promise<TerminalHandle> {
  const env:NodeJS.ProcessEnv={...process.env, HERDR_CONFIG_PATH: `${o.configDir}/config.toml`, XDG_CONFIG_HOME:join(o.configDir,'.remote-helper','config'), XDG_STATE_HOME:join(o.configDir,'.remote-helper','state'), ...(o.socketPath?{HERDR_SOCKET_PATH:o.socketPath}:{})};
  delete env.HERDR_SESSION;
  const child = spawn(o.herdr, terminalArgs(o), {env, stdio: ['pipe','pipe','pipe']});
  let closed = false, buffer = '', stderr = '', previous = -1, first = true;
  let readyResolve!:()=>void,readyReject!:(e:unknown)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const startupTimer=setTimeout(()=>close('helper_timeout'),5000);
  const close = (reason: string) => { if (closed) return; closed = true; clearTimeout(startupTimer); child.kill('SIGTERM'); if(first)readyReject(new BackendError(reason,reason==='controller_conflict'?'Another terminal controller already owns this pane':'Terminal helper closed before a full frame',reason==='controller_conflict'?409:503)); o.onClose(reason); };
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
  child.stdout.on('data', data => {
    buffer += data.toString();
    if (buffer.length > 4 * 1024 * 1024) return close('frame_limit');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,nl); buffer = buffer.slice(nl+1);
      try {
        const frame = JSON.parse(line);
        if(frame.type==='terminal.closed')return close(/controller|control|attached|takeover|busy|ownership/i.test(String(frame.reason))?'controller_conflict':'session_closed');
        if (frame.type !== 'terminal.frame') continue;
        if (frame.encoding !== 'ansi' || !Number.isSafeInteger(frame.seq) || frame.seq < 0 || typeof frame.full !== 'boolean' ||
          !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.width > 1000 || frame.height < 1 || frame.height > 1000 ||
          typeof frame.bytes !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.bytes)) return close('invalid_frame');
        if (first && !frame.full) return close('full_frame_required');
        if (!first && frame.seq !== previous + 1 && !frame.full) return close('frame_gap');
        first = false; previous = frame.seq; clearTimeout(startupTimer); readyResolve();
        o.onFrame({type:'pane_frame', paneId:o.paneId, identityToken:o.identityToken, seq:frame.seq, full:frame.full, width:frame.width,height:frame.height,bytes:compactFrame(Buffer.from(frame.bytes,'base64')).toString('base64')});
      } catch { return close('invalid_frame'); }
    }
  });
  child.once('error', () => close('helper_unavailable'));
  child.once('close', code => close(code === 0 ? 'released' : /controller|ownership|busy|taken|already has an attached client|retry with --takeover/i.test(stderr) ? 'controller_conflict' : 'helper_exited'));
  // A first full frame acknowledges native observer/controller admission. Spawn alone does not.
  await ready;
  return {
    async command(value) {
      if (closed) throw new BackendError('terminal_closed','Terminal helper is closed',409);
      if (!o.control) throw new BackendError('read_only','Observer cannot write or resize',403);
      if (!['terminal.input','terminal.resize','terminal.scroll','terminal.release'].includes(String(value.type))) throw new BackendError('invalid_command','Unknown terminal command',400);
      if(value.type==='terminal.resize'&&(!Number.isInteger(value.cols)||Number(value.cols)<20||Number(value.cols)>400||!Number.isInteger(value.rows)||Number(value.rows)<5||Number(value.rows)>200))throw new BackendError('invalid_dimensions','Invalid terminal dimensions',400);
      if(value.type==='terminal.scroll'&&(!['up','down'].includes(String(value.direction))||!Number.isInteger(value.lines)||Number(value.lines)<1||Number(value.lines)>1000))throw new BackendError('invalid_scroll','Invalid scroll command',400);
      if(value.type==='terminal.input'&&((typeof value.text==='string')===(typeof value.bytes==='string')||(value.text!==undefined&&typeof value.text!=='string')||(value.bytes!==undefined&&typeof value.bytes!=='string')))throw new BackendError('invalid_input','Exactly one text or bytes field is required',400);
      if(value.type==='terminal.input'&&typeof value.bytes==='string'&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytes))throw new BackendError('invalid_input','bytes must be base64',400);
      if(Buffer.byteLength(JSON.stringify(value))>100_000)throw new BackendError('input_limit','Terminal command exceeds the limit',413);
      if (child.stdin.writableLength > 64 * 1024) throw new BackendError('terminal_backpressure','Terminal input queue is full',429);
      await new Promise<void>((resolve,reject) => child.stdin.write(JSON.stringify(value)+'\n', error => error ? reject(new BackendError('terminal_write','Terminal helper write failed',503,true)) : resolve()));
    },
    close: () => close('released'),
  };
}
