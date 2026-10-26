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
      CREATE TABLE IF NOT EXISTS operations (device TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL,PRIMARY KEY(device,id));`);
    if (recover) this.db.query("UPDATE operations SET state='unknown' WHERE state='pending'").run();
    this.db.query("INSERT OR IGNORE INTO metadata VALUES ('hostId',?)").run(randomUUID());
  }
  get hostId() { return (this.db.query("SELECT value FROM metadata WHERE key='hostId'").get() as {value:string}).value; }
  invite(scope: Scope, ttlSeconds=300) {
    if (!["read","control"].includes(scope) || !Number.isInteger(ttlSeconds) || ttlSeconds<1 || ttlSeconds>3600) throw new BridgeError("invalid_request","Invalid invitation options");
    const code=secret(), expiresAt=Date.now()+ttlSeconds*1000;
    this.db.transaction(() => { this.db.query("DELETE FROM invitations WHERE expires<?").run(Date.now()); this.db.query("INSERT INTO invitations VALUES (?,?,?)").run(hash(code),scope,expiresAt); })();
    return {code,expiresAt:new Date(expiresAt).toISOString()};
  }
  pair(code:string,name:string) {
    return this.db.transaction(() => {
      const invite=this.db.query("DELETE FROM invitations WHERE digest=? AND expires>? RETURNING scope").get(hash(code),Date.now()) as {scope:Scope}|null;
      if (!invite) throw new BridgeError("invitation_expired","Invalid invitation",410);
      const id=randomUUID(),token=secret();
      this.db.query("INSERT INTO devices VALUES (?,?,?,?,?,NULL)").run(id,name,invite.scope,hash(token),Date.now());
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
