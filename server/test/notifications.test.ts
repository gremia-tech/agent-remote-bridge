import {test,expect} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {State} from "../src/state";
import {createNotifications,genericPayload} from "../notifications";
import type {HostBackend} from "../src/backend/types";

test("push is generic and never contains project, prompt or terminal content",()=>{
  const encoded=JSON.stringify(genericPayload("public-host-id"));
  expect(encoded).toContain("Open Herdr Remote");expect(encoded).not.toContain("paneId");expect(encoded).not.toContain("workspace");
});
test("notification registration authenticates outside route, validates token, coalesces transitions, and skips revoked device",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"hmr-push-")),state=new State(directory);
  let status="working";const sent:object[]=[];
  const backend={snapshot:async()=>({agents:[{paneId:"p1",identityToken:"stable",status,secret:"PRIVATE PROMPT"}]})} as unknown as HostBackend;
  const invite=state.invite("read"),credential=state.pair(invite.code,"test phone"),device=state.authenticate(credential.token);
  const notifications=createNotifications({state,backend,sender:async(_,payload)=>{sent.push(payload);return 200;},pollMilliseconds:100_000});
  try {
    const url=new URL("https://localhost/v1/notifications");
    const response=await notifications.route(new Request(url.toString(),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:"a".repeat(64),environment:"sandbox"})}),url,device);
    expect(response?.status).toBe(200);
    await new Promise(resolve=>setTimeout(resolve,0));status="blocked";await notifications.poll();await notifications.poll();
    expect(sent).toHaveLength(1);expect(JSON.stringify(sent)).not.toContain("PRIVATE");
    state.revoke(device.id);status="working";await notifications.poll();status="done";await notifications.poll();expect(sent).toHaveLength(1);
    expect((await notifications.route(new Request(url.toString(),{method:"DELETE"}),url,device))?.status).toBe(200);
  } finally {notifications.close();state.close();rmSync(directory,{recursive:true,force:true});}
});
test("unconfigured provider does not accept a token",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"hmr-no-push-")),state=new State(directory);
  const notifications=createNotifications({state,backend:{} as HostBackend});
  try {const url=new URL("https://localhost/v1/notifications");await expect(notifications.route(new Request(url.toString(),{method:"POST"}),url,{} as never)).rejects.toMatchObject({status:501});}
  finally {notifications.close();state.close();rmSync(directory,{recursive:true,force:true});}
});
