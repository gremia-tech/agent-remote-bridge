import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {loadOrcaConnection,parseOrcaConnection} from '../src/backend/orca/connection';
const offer={v:2,endpoint:'ws://127.0.0.1:6768',scope:'runtime',publicKeyB64:Buffer.alloc(32,3).toString('base64'),deviceToken:'x'.repeat(43)};
test('Orca access accepts native runtime URI and private JSON without mixing phone invitations',()=>{
 const uri='orca://pair?code='+Buffer.from(JSON.stringify(offer)).toString('base64url');
 expect(parseOrcaConnection(uri)).toEqual(parseOrcaConnection(JSON.stringify(offer)));
 for(const patch of [{scope:'mobile'},{v:1},{endpoint:'ws://remote.example:6768'},{endpoint:'ws://user:pass@127.0.0.1:6768'},{endpoint:'ws://127.0.0.1:6768/?token=abc'},{endpoint:'https://127.0.0.1:6768'},{publicKeyB64:'invalid'},{deviceToken:'a\r\nb'},{relay:{v:1}}])expect(()=>parseOrcaConnection(JSON.stringify({...offer,...patch}))).toThrow();
 expect(()=>parseOrcaConnection('x'.repeat(16385))).toThrow();
 const lan='orca://pair?code='+Buffer.from(JSON.stringify({...offer,endpoint:'ws://192.0.2.10:6768'})).toString('base64url');
 const wrapped=JSON.stringify({pairingUrl:lan,localEndpoint:'ws://127.0.0.1:6768'});expect(parseOrcaConnection(wrapped).endpoint).toBe('ws://127.0.0.1:6768/');
 expect(parseOrcaConnection(wrapped).publicKeyB64).toBe(offer.publicKeyB64);
 expect(()=>parseOrcaConnection(JSON.stringify({pairingUrl:lan,localEndpoint:'ws://remote.invalid:6768'}))).toThrow();
});
test('Orca server-side credentials require a private nonsymlink regular file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'orca-access-'));try{const p=join(dir,'access');writeFileSync(p,JSON.stringify(offer),{mode:0o600});expect(loadOrcaConnection(p).scope).toBe('runtime');chmodSync(p,0o644);expect(()=>loadOrcaConnection(p)).toThrow();chmodSync(p,0o600);symlinkSync(p,join(dir,'link'));expect(()=>loadOrcaConnection(join(dir,'link'))).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}
});
