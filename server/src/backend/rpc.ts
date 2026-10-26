import { createConnection } from 'node:net';
import { BackendError } from './types';
let serial = 0;
/** One JSONL request per Unix socket; never retries a potentially delivered write. */
export function rpc(socketPath: string, method: string, params: Record<string, unknown> = {}, mutation = false, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `mobile-${++serial}`;
    let settled = false, written = false, size = 0;
    const chunks: Buffer[] = [];
    const socket = createConnection(socketPath);
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const failed = (code: string, message: string) => finish(new BackendError(code, message, 503, mutation && written));
    const timer = setTimeout(() => failed('herdr_timeout', 'Herdr did not acknowledge the request'), timeout);
    socket.once('connect', () => { if(settled)return; try {written = true; socket.write(JSON.stringify({ id, method, params }) + '\n');}catch{failed('herdr_write','Could not write the Herdr request');} });
    socket.on('data', chunk => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += data.length;
      if (size > 16 * 1024 * 1024) return failed('herdr_reply_limit', 'Herdr reply exceeded the size limit');
      chunks.push(data);
      if (!data.includes(10)) return;
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0]!);
        if (reply.id !== id) throw Error('Unexpected reply identifier');
        if (reply.error) {
          const c = String(reply.error.code);
          finish(new BackendError(c, String(reply.error.message), /not_found|unknown_pane|unknown_workspace/.test(c) ? 404 : /controller|busy|conflict/.test(c) ? 409 : /unknown_method|unsupported|invalid_request/.test(c) ? 501 : 400));
        } else if ('result' in reply) finish(undefined, reply.result);
        else throw Error('Missing result');
      } catch { failed('herdr_protocol', 'Herdr returned an invalid reply'); }
    });
    socket.once('error', () => failed('herdr_unavailable', 'Cannot connect to the selected Herdr session'));
    socket.once('close', () => { if (!settled) failed('herdr_closed', 'Herdr closed before acknowledging the request'); });
  });
}
