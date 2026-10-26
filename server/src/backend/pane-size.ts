import { readlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export interface TerminalSize { cols: number; rows: number; }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
export const boundedSize = (size: TerminalSize): TerminalSize => ({ cols: clamp(size.cols, 20, 400), rows: clamp(size.rows, 5, 200) });

function run(command: string, args: string[], timeout = 2000): Promise<string | undefined> {
  return new Promise(resolve => {
    let out = '', done = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (value?: string) => { if (done) return; done = true; clearTimeout(timer); child.kill('SIGKILL'); resolve(value); };
    const timer = setTimeout(() => finish(), timeout);
    child.stdout.on('data', data => { out += data.toString(); if (out.length > 4096) finish(); });
    child.once('error', () => finish());
    child.once('close', code => finish(code === 0 ? out : undefined));
  });
}

/** Controlling terminal of a process owned by this user, as a device path. */
async function terminalDevice(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    const target = await readlink(`/proc/${pid}/fd/0`).catch(() => undefined);
    return target && /^\/dev\/pts\/\d{1,6}$/.test(target) ? target : undefined;
  }
  const name = (await run('ps', ['-o', 'tty=', '-p', String(pid)]))?.trim();
  return name && /^ttys\d{1,6}$/.test(name) ? `/dev/${name}` : undefined;
}

/**
 * Exact rows/columns of the pane's pseudo-terminal, read with stty from the
 * pane's shell process. Read-only: it neither writes to nor resizes the terminal.
 */
export async function ttySize(pid: unknown): Promise<TerminalSize | undefined> {
  if (!Number.isSafeInteger(pid) || (pid as number) < 2) return undefined;
  const device = await terminalDevice(pid as number);
  if (!device) return undefined;
  const output = await run('stty', [process.platform === 'linux' ? '-F' : '-f', device, 'size']);
  const match = output && /^(\d{1,4}) (\d{1,4})\s*$/.exec(output);
  if (!match) return undefined;
  const rows = Number(match[1]), cols = Number(match[2]);
  return rows > 0 && cols > 0 ? boundedSize({ cols, rows }) : undefined;
}
