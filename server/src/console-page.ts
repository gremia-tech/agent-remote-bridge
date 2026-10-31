// The console's single page. Self-contained (no CDN, no external requests) so it works offline and the
// strict Content-Security-Policy in console.ts holds. Text is set with textContent, never innerHTML,
// except the QR SVG the bridge itself generated.
export const consolePage=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Remote Console</title>
<style>
:root{--bg:#f6f6f4;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e2e2dc;--accent:#2457d6;--good:#1f8a4c;--warn:#b26a00;--bad:#c23030;--field:#fbfbf9;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--text:#ececea;--muted:#9a9a94;--line:#33332f;--accent:#7aa2ff;--good:#4cc27e;--warn:#e6a23c;--bad:#ff6b6b;--field:#242421;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
header{max-width:960px;margin:0 auto;padding:24px 16px 8px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{font-size:20px;margin:0}header .muted{flex:1}
main{max-width:960px;margin:0 auto;padding:8px 16px 48px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
section.wide{grid-column:1/-1}h2{font-size:15px;margin:0 0 12px;display:flex;justify-content:space-between;align-items:center}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.muted{color:var(--muted)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--muted)}
.ok .dot{background:var(--good)}.warn .dot{background:var(--warn)}.bad .dot{background:var(--bad)}
label{display:grid;gap:4px;margin:0 0 10px;font-size:13px;color:var(--muted)}label.check{display:flex;gap:8px;align-items:center;color:var(--text);font-size:14px}
input,select,textarea{font:inherit;color:var(--text);background:var(--field);border:1px solid var(--line);border-radius:8px;padding:7px 9px;width:100%}
input[type=checkbox]{width:auto}textarea{min-height:90px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
button{font:inherit;font-size:14px;border:1px solid var(--line);background:var(--field);color:var(--text);border-radius:8px;padding:7px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad)}button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row select{width:auto;flex:0 1 auto}table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;padding:7px 4px;border-top:1px solid var(--line);vertical-align:middle}th{color:var(--muted);font-weight:500;border-top:0}
.qr{background:#fff;border-radius:8px;padding:8px;width:min(280px,100%);margin-top:12px}.qr svg{display:block;width:100%;height:auto}
#notice{position:sticky;top:0;z-index:2;display:none;max-width:960px;margin:0 auto;padding:10px 16px}#notice div{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:10px 12px}
#notice.error div{border-left-color:var(--bad)}.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px}
#gate{max-width:520px;margin:15vh auto;padding:0 16px;text-align:center}
</style></head><body>
<div id="gate" hidden><h1>Agent Remote Console</h1><p class="muted" id="gate-text">Run <span class="mono">herdr-remote console</span> on this computer and open the link it prints.</p></div>
<div id="notice"><div id="notice-text"></div></div>
<div id="app" hidden>
<header><h1>Agent Remote</h1><span class="muted" id="subtitle"></span><button id="refresh">Refresh</button></header>
<main>
<section><h2>Bridge</h2><dl id="bridge"></dl></section>
<section><h2>Reaching this computer</h2><dl id="routes"></dl></section>
<section class="wide"><h2>Pair a phone</h2>
 <div class="row"><select id="pair-scope" aria-label="Access"><option value="control">Can type and control</option><option value="read">Read only</option></select>
 <select id="pair-ttl" aria-label="Valid for"><option value="300">Valid 5 minutes</option><option value="900">Valid 15 minutes</option><option value="3600">Valid 1 hour</option></select>
 <button class="primary" id="pair">Show pairing QR code</button></div>
 <p class="muted" id="pair-note">Scan it with the AI Agent Remote app. It works once and contains a secret: don't share a screenshot.</p><div id="qr"></div></section>
<section class="wide"><h2>Devices</h2><table><thead><tr><th>Name</th><th>Access</th><th>Paired</th><th></th></tr></thead><tbody id="devices"></tbody></table></section>
<section><h2>Settings <span class="muted" style="font-weight:400;font-size:12px">saved to config.json</span></h2><form id="settings"></form></section>
<section><h2>Relay</h2><div id="relay"></div></section>
<section><h2>Certificate</h2><dl id="certificate"></dl><div class="row" style="margin-top:12px"><button id="renew">Renew now</button></div>
 <p class="muted">Paired phones pick up the new certificate the next time they connect and keep working after the switch. Renewal also happens automatically 30 days before expiry.</p></section>
</main></div>
<script>
"use strict";
let csrf="";const $=id=>document.getElementById(id);
function el(tag,props,...children){const n=document.createElement(tag);Object.assign(n,props||{});for(const c of children)n.append(c);return n;}
function notice(text,error){const n=$("notice");$("notice-text").textContent=text;n.className=error?"error":"";n.style.display=text?"block":"none";if(text&&!error)setTimeout(()=>{if($("notice-text").textContent===text)n.style.display="none";},5000);}
async function api(path,method,body){
  const r=await fetch("/api/"+path,{method:method||"GET",credentials:"same-origin",headers:Object.assign({"Content-Type":"application/json"},method&&method!=="GET"?{"X-Console-CSRF":csrf}:{}),body:body===undefined?undefined:JSON.stringify(body)});
  const v=await r.json().catch(()=>({}));if(!r.ok)throw new Error(v.error||("Request failed ("+r.status+")"));return v;
}
function rows(target,entries){const d=$(target);d.replaceChildren();for(const [k,v,cls] of entries){if(v===undefined||v===null||v==="")continue;const dd=el("dd");if(cls){dd.className=cls;dd.append(el("span",{className:"dot"}));}dd.append(String(v));d.append(el("dt",{textContent:k}),dd);}}
const when=s=>s?new Date(s).toLocaleString():"";
const days=s=>Math.round((Date.parse(s)-Date.now())/864e5);
let restartNeeded=false;
function needRestart(){restartNeeded=true;notice("Saved. Restart the bridge to apply: phones reconnect by themselves.");renderRestart();}
function renderRestart(){const b=$("restart-btn");if(b)b.hidden=!restartNeeded;}
async function load(){
  const [s,c,devices]=await Promise.all([api("status"),api("config"),api("devices").catch(()=>[])]);
  $("subtitle").textContent="bridge "+s.version;
  const b=s.bridge||{};
  rows("bridge",[["Status",s.running?"Running":"Restarting",s.running?"ok":"warn"],["Name",b.hostName],["Backend",b.backend],["Phone API",b.listen&&(b.listen+":"+b.port)],["Saved address",b.url],["Paired devices",b.devices],["Running since",when(b.startedAt)]]);
  const r=s.relay;
  rows("routes",[["Local network",b.localAddresses&&b.localAddresses.length?b.localAddresses.join(", "):"Only this computer",b.localAddresses&&b.localAddresses.length?"ok":"warn"],["Nearby discovery",b.discoverable?"On, phones can pair with a code":"Off"],
    ["Relay",r?(r.connected?"Connected to "+r.host:"Not connected ("+(r.lastError||"retrying")+")"):"Not joined",r?(r.connected?"ok":"bad"):""],
    ["Relay admission",r&&r.connected?(r.revision>=2?(r.sharedPhoneToken?"Per-device credentials, shared token still accepted":"Per-device credentials only"):"Shared token (update the relay for per-device credentials)"):undefined],
    ["Relay activity",r&&r.connected?(r.admitted+" phone connections, "+r.rejected+" rejected"+(r.replaced?", replaced "+r.replaced+" times":"")):undefined,r&&r.replaced?"warn":""]]);
  const cert=s.certificate||{};
  rows("certificate",[["Fingerprint",cert.pin&&cert.pin.slice(0,4)+"-"+cert.pin.slice(4,8)+"…"],["Expires",cert.expiresAt&&when(cert.expiresAt)+" ("+days(cert.expiresAt)+" days)",cert.expiresAt?(days(cert.expiresAt)<30?"warn":"ok"):""],["Successor",cert.next&&("ready, switches "+when(cert.next.switchAt))]]);
  const tbody=$("devices");tbody.replaceChildren();
  const active=devices.filter(d=>!d.revokedAt);
  if(!active.length)tbody.append(el("tr",{},el("td",{colSpan:4,className:"muted",textContent:"No phones paired yet."})));
  for(const d of active){
    const name=el("input",{value:d.name,ariaLabel:"Device name"});name.addEventListener("change",async()=>{try{await api("devices/"+d.id+"/rename","POST",{name:name.value});notice("Renamed.");}catch(e){notice(e.message,true);}});
    const revoke=el("button",{className:"danger",textContent:"Revoke"});
    revoke.addEventListener("click",async()=>{if(!confirm("Revoke "+d.name+"? It stops working at once and must pair again."))return;try{await api("devices/"+d.id+"/revoke","POST",{});notice("Revoked "+d.name+".");load();}catch(e){notice(e.message,true);}});
    tbody.append(el("tr",{},el("td",{},name),el("td",{textContent:d.scope==="control"?"Control":"Read only"}),el("td",{textContent:when(d.createdAt)}),el("td",{},revoke)));
  }
  renderSettings(c);renderRelay(r);
}
function field(form,key,label,value,type,options){
  let input;
  if(type==="select"){input=el("select");for(const [v,t] of options)input.append(el("option",{value:v,textContent:t,selected:String(value)===v}));}
  else if(type==="check"){input=el("input",{type:"checkbox",checked:!!value});const l=el("label",{className:"check"},input,label);input.name=key;form.append(l);return;}
  else input=el("input",{type:type||"text",value:value==null?"":String(value)});
  input.name=key;form.append(el("label",{},label,input));
}
function renderSettings(c){
  const f=$("settings");f.replaceChildren();
  field(f,"hostName","Name shown on the phone",c.hostName);
  field(f,"port","Phone API port",c.port,"number");
  field(f,"listen","Listen address (127.0.0.1 = this computer only, 0.0.0.0 = local network)",c.listen);
  field(f,"backend","Terminal backend",c.backend||"herdr","select",[["herdr","Herdr"],["plain","Plain terminals (no multiplexer)"],["orca","Orca"]]);
  field(f,"herdr","Herdr program",c.herdr);
  field(f,"session","Herdr session (empty = default)",c.session||"");
  field(f,"discoverable","Show this computer to phones on the same Wi-Fi (pair with a code)",c.discoverable,"check");
  field(f,"nearbyScope","Access for phones paired with a code",c.nearbyScope||"control","select",[["control","Can type and control"],["read","Read only"]]);
  field(f,"localRoute","When joined to a relay, also accept paired phones on this network",c.localRoute!==false,"check");
  field(f,"console","Open this console when the bridge starts",c.console!==false,"check");
  field(f,"consolePort","Console port",c.consolePort||8790,"number");
  const save=el("button",{className:"primary",type:"submit",textContent:"Save"}),restart=el("button",{type:"button",id:"restart-btn",textContent:"Restart bridge now"});
  restart.addEventListener("click",doRestart);f.append(el("div",{className:"row"},save,restart));renderRestart();
}
$("settings").addEventListener("submit",async e=>{
  e.preventDefault();const f=e.target,v={};
  for(const i of f.querySelectorAll("input,select")){if(i.type==="checkbox")v[i.name]=i.checked;else if(i.type==="number")v[i.name]=Number(i.value);else v[i.name]=i.value.trim()||null;}
  if(v.session===null)v.session=null;
  try{await api("config","PUT",v);needRestart();}catch(err){notice(err.message,true);}
});
async function doRestart(){notice("Restarting the bridge…");try{await api("restart","POST",{});restartNeeded=false;notice("Bridge restarted.");await load();}catch(e){notice(e.message,true);}}
function renderRelay(r){
  const box=$("relay");box.replaceChildren();
  if(r){
    box.append(el("p",{},"Joined "+r.host+". Paired phones reach this computer through it from anywhere."));
    const leave=el("button",{className:"danger",textContent:"Leave relay"});leave.addEventListener("click",async()=>{if(!confirm("Leave the relay? Phones away from this network can no longer connect."))return;try{await api("relay/leave","POST",{});needRestart();load();}catch(e){notice(e.message,true);}});
    box.append(leave);return;
  }
  box.append(el("p",{className:"muted",textContent:"Paste the private relay profile (JSON) from your relay server to reach this computer from anywhere. No port needs to be opened here."}));
  const t=el("textarea",{ariaLabel:"Relay profile",placeholder:'{"version":1,"host":{...},"phone":{...}}'}),join=el("button",{className:"primary",textContent:"Join relay"});
  join.addEventListener("click",async()=>{try{await api("relay/join","POST",{profile:t.value});t.value="";needRestart();load();}catch(e){notice(e.message,true);}});
  box.append(t,el("div",{className:"row",style:"margin-top:8px"},join));
}
$("pair").addEventListener("click",async()=>{
  try{const v=await api("pair","POST",{scope:$("pair-scope").value,ttl:Number($("pair-ttl").value)});
    const q=el("div",{className:"qr"});q.innerHTML=v.svg;$("qr").replaceChildren(q,el("p",{className:"muted",textContent:"Expires "+when(v.expiresAt)+(v.relay?". Works at home and away (through the relay).":". Works on this network.")}));
    setTimeout(()=>$("qr").replaceChildren(),Date.parse(v.expiresAt)-Date.now());
  }catch(e){notice(e.message,true);}
});
$("renew").addEventListener("click",async()=>{if(!confirm("Create a new certificate? Phones switch to it automatically when they next connect within 14 days; phones that don't connect in that time must pair again."))return;try{await api("certificate/renew","POST",{days:14});notice("Successor certificate created.");load();}catch(e){notice(e.message,true);}});
$("refresh").addEventListener("click",()=>load().catch(e=>notice(e.message,true)));
(async()=>{
  const launch=new URLSearchParams(location.hash.slice(1)).get("launch");
  if(launch)history.replaceState(null,"",location.pathname);
  try{
    const r=launch?await fetch("/api/session",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({launch})}):await fetch("/api/session",{credentials:"same-origin"});
    const v=await r.json();if(!r.ok)throw new Error(v.error);csrf=v.csrf;$("app").hidden=false;await load();
  }catch(e){$("gate").hidden=false;if(launch)$("gate-text").textContent=e.message;}
})();
</script></body></html>`;
