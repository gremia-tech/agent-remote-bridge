import {expect,test} from "bun:test";
import {connectionProfile} from "../src/connection";
const token="a".repeat(64),target="https://10.88.0.1:8787";
test("profiles accept only explicit route kinds and retain separate host destination",()=>{
 expect(connectionProfile({mode:"gateway",gateway:{url:"wss://gateway.example/v1/tunnel",token}},target).mode).toBe("gateway");
 expect(connectionProfile({mode:"wireguard",wireGuardJSON:JSON.stringify({version:1,runnerAddress:"10.88.0.1",runnerPort:8787})},target).mode).toBe("wireguard");
 for(const route of [{mode:"unknown"},{mode:"gateway",gateway:{url:"ws://gateway.example/v1/tunnel",token}},{mode:"gateway",gateway:{url:"wss://user:pass@gateway.example/v1/tunnel",token}},{mode:"gateway",gateway:{url:"wss://gateway.example/v1/tunnel",token,basicUsername:"only"}},{mode:"gateway",gateway:{url:"wss://gateway.example/v1/tunnel",token,accessClientID:"bad\nheader",accessClientSecret:"x"}},{mode:"wireguard",wireGuardJSON:JSON.stringify({version:1,runnerAddress:"10.88.0.8",runnerPort:8787})},{mode:"gateway",gateway:{url:"wss://gateway.example/v1/tunnel",token},wireGuardJSON:"{}"}])expect(()=>connectionProfile(route,target)).toThrow();
});
