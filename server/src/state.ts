import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BridgeError } from "./errors";

export type Scope = "read" | "control";
export interface Device { id: string; name: string; scope: Scope; createdAt: number; revokedAt: number | null; }
export interface Operation { requestId: string; state: "pending"|"accepted"|"failed"|"unknown"; result?: unknown; }
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function privateDirectory(path: string) {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error("State directory must be a real directory");
  mkdirSync(path,{recursive:true,mode:0o700}); chmodSync(path,0o700);
}
export class State {
  readonly db: Database;
  readonly path: string;
  constructor(readonly directory: string, readonly recover = false) {
    privateDirectory(directory);
    this.path=join(directory,"state.sqlite");
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new Error("State database cannot be a symlink");
    this.db=new Database(this.path,{create:true,strict:true}); chmodSync(this.path,0o600);
    // DELETE journal avoids loose WAL credentials. Tokens and invitation codes themselves never enter storage.
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invitations (digest TEXT PRIMARY KEY,scope TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY,name TEXT NOT NULL,scope TEXT NOT NULL,digest TEXT UNIQUE NOT NULL,created INTEGER NOT NULL,revoked INTEGER);
      CREATE TABLE IF NOT EXISTS operations (device TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL,PRIMARY KEY(device,id));
      CREATE TABLE IF NOT EXISTS relay_credentials (digest TEXT PRIMARY KEY,invitation TEXT,device TEXT,expires INTEGER);`);
    // Older state files predate multi-use invitations.
    if (!(this.db.query("PRAGMA table_info(invitations)").all() as {name:string}[]).some(c=>c.name==="uses")) this.db.exec("ALTER TABLE invitations ADD COLUMN uses INTEGER NOT NULL DEFAULT 1");
    if (recover) this.db.query("UPDATE operations SET state='unknown' WHERE state='pending'").run();
    this.db.query("INSERT OR IGNORE INTO metadata VALUES ('hostId',?)").run(randomUUID());
  }
  get hostId() { return (this.db.query("SELECT value FROM metadata WHERE key='hostId'").get() as {value:string}).value; }
  metadata(key:string) { return (this.db.query("SELECT value FROM metadata WHERE key=?").get(key) as {value:string}|null)?.value; }
  setMetadata(key:string,value:string) { this.db.query("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value); }
  /** `relay` also mints this invitation's own relay credential; pairing binds it to the new device. */
  /** `uses` > 1 and lifetimes beyond an hour are for owner-made invitations such as an app reviewer's (CLI only). */
  invite(scope: Scope, ttlSeconds=300, relay=false, uses=1) {
    if (!["read","control"].includes(scope) || !Number.isInteger(ttlSeconds) || ttlSeconds<1 || ttlSeconds>2_592_000 || !Number.isInteger(uses) || uses<1 || uses>20) throw new BridgeError("invalid_request","Invalid invitation options");
    const code=secret(), expiresAt=Date.now()+ttlSeconds*1000, relayToken=relay?secret():undefined;
    this.db.transaction(() => {
      this.db.query("DELETE FROM invitations WHERE expires<?").run(Date.now());
      this.db.query("DELETE FROM relay_credentials WHERE device IS NULL AND expires<?").run(Date.now());
      this.db.query("INSERT INTO invitations (digest,scope,expires,uses) VALUES (?,?,?,?)").run(hash(code),scope,expiresAt,uses);
      if (relayToken) this.db.query("INSERT INTO relay_credentials VALUES (?,?,NULL,?)").run(hash(relayToken),hash(code),expiresAt);
    })();
    return {code,expiresAt:new Date(expiresAt).toISOString(),...(relayToken?{relayToken}:{})};
  }
  /** A fresh relay credential for an already paired device; it replaces the device's previous one. */
  relayCredential(device:string) {
    const token=secret();
    this.db.transaction(() => { this.db.query("DELETE FROM relay_credentials WHERE device=?").run(device); this.db.query("INSERT INTO relay_credentials VALUES (?,NULL,?,NULL)").run(hash(token),device); })();
    return token;
  }
  /** Digests the relay may admit: active devices' credentials and those of unexpired invitations. */
  relayDigests(): string[] {
    return (this.db.query("SELECT r.digest FROM relay_credentials r LEFT JOIN devices d ON d.id=r.device WHERE (r.device IS NOT NULL AND d.revoked IS NULL AND d.id IS NOT NULL) OR (r.device IS NULL AND r.expires>?) ORDER BY r.digest").all(Date.now()) as {digest:string}[]).map(r=>r.digest);
  }
  rename(id:string,name:string) { return this.db.query("UPDATE devices SET name=? WHERE id=?").run(name,id).changes>0; }
  pair(code:string,name:string) {
    return this.db.transaction(() => {
      const invite=this.db.query("UPDATE invitations SET uses=uses-1 WHERE digest=? AND expires>? AND uses>0 RETURNING scope,uses").get(hash(code),Date.now()) as {scope:Scope;uses:number}|null;
      if (!invite) throw new BridgeError("invitation_expired","Invalid invitation",410);
      if (invite.uses<=0) this.db.query("DELETE FROM invitations WHERE digest=?").run(hash(code));
      const id=randomUUID(),token=secret();
      this.db.query("INSERT INTO devices VALUES (?,?,?,?,?,NULL)").run(id,name,invite.scope,hash(token),Date.now());
      this.db.query("UPDATE relay_credentials SET device=?,invitation=NULL,expires=NULL WHERE invitation=?").run(id,hash(code));
      return {deviceId:id,token,scope:invite.scope};
    }).immediate();
  }
  authenticate(token:string): Device {
    const d=this.db.query("SELECT id,name,scope,created AS createdAt,revoked AS revokedAt FROM devices WHERE digest=? AND revoked IS NULL").get(hash(token)) as Device|null;
    if (!d) throw new BridgeError("invalid_credentials","Invalid credential",401);
    return d;
  }
  active(id:string) { return !!this.db.query("SELECT 1 FROM devices WHERE id=? AND revoked IS NULL").get(id); }
  devices(): Device[] { return this.db.query("SELECT id,name,scope,created AS createdAt,revoked AS revokedAt FROM devices ORDER BY created").all() as Device[]; }
  revoke(id:string) { return this.db.query("UPDATE devices SET revoked=? WHERE id=? AND revoked IS NULL").run(Date.now(),id).changes>0; }
  operation(device:string,id:string): Operation {
    const row=this.db.query("SELECT id AS requestId,state,result FROM operations WHERE device=? AND id=?").get(device,id) as {requestId:string,state:Operation["state"],result:string|null}|null;
    if (!row) throw new BridgeError("not_found","Unknown operation",404);
    return {requestId:row.requestId,state:row.state,...(row.result ? {result:JSON.parse(row.result)} : {})};
  }
  begin(device:string,id:string,digest:string): {fresh:boolean;operation:Operation} {
    return this.db.transaction(() => {
      const previous=this.db.query("SELECT digest FROM operations WHERE device=? AND id=?").get(device,id) as {digest:string}|null;
      if(previous) {
        if(previous.digest!==digest) throw new BridgeError("request_conflict","Request mismatch",409);
        return {fresh:false,operation:this.operation(device,id)};
      }
      const count=this.db.query("SELECT count(*) AS count FROM operations WHERE device=?").get(device) as {count:number};
      if(count.count>=10_000) throw new BridgeError("journal_full","Journal limit",429);
      this.db.query("INSERT INTO operations VALUES (?,?,?,'pending',NULL,?)").run(device,id,digest,Date.now());
      return {fresh:true,operation:{requestId:id,state:"pending" as const}};
    }).immediate();
  }
  finish(device:string,id:string,state:"accepted"|"failed"|"unknown",result:unknown) {
    this.db.query("UPDATE operations SET state=?,result=? WHERE device=? AND id=? AND state='pending'").run(state,JSON.stringify(result),device,id);
    return this.operation(device,id);
  }
  close() { this.db.close(); }
}
export function canonical(value:unknown,omit?:Set<string>):string {
  if (Array.isArray(value)) return `[${value.map(item=>canonical(item,omit)).join(",")}]`;
  if (value && typeof value==="object") return `{${Object.entries(value).filter(([k])=>!omit?.has(k)).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v,omit)}`).join(",")}}`;
  return JSON.stringify(value);
}
