import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';

test('local HTTP app protects routes and supports explicit, automatic, and per-project command approvals',async t=>{
  await fs.mkdir(path.join(process.cwd(),'.local-data'),{recursive:true});
  const base=await fs.mkdtemp(path.join(process.cwd(),'.local-data','http-test-'));
  const project=path.join(base,'project');await fs.mkdir(project);
  const port=4329,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),FORGE_DATA_DIR:path.join(base,'state'),FORGE_SKIP_ENV_FILE:'1',OPENAI_API_KEY:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  let ready=false;
  for(let attempt=0;attempt<50;attempt++){try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await pause(100);}
  assert.ok(ready,'server should start');
  const initial=await fetch(origin);assert.equal(initial.status,200);const cookie=initial.headers.get('set-cookie').split(';')[0];
  const get=(route,headers={})=>fetch(origin+'/api/'+route,{headers:{cookie,...headers}});
  const post=(route,data,headers={})=>fetch(origin+'/api/'+route,{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Forge-Request':'1',...headers},body:JSON.stringify(data)});
  assert.equal((await fetch(origin+'/api/state')).status,401);
  assert.equal((await get('state',{Origin:'https://untrusted.example'})).status,403);
  const invalidHost=await new Promise((resolve,reject)=>{http.get(origin+'/api/state',{headers:{Host:'untrusted.example',cookie}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(invalidHost,403);
  assert.equal((await post('project',{path:project},{'X-Forge-Request':''})).status,403);
  assert.equal((await post('project',{path:project})).status,200);
  assert.equal((await fetch(origin+'/project-command.js')).status,200);
  assert.equal((await fetch(origin+'/voice-input.js')).status,200);
  assert.equal((await fetch(origin+'/live-transcription.js')).status,200);
  assert.equal((await fetch(origin+'/microphone-meter.js')).status,200);
  assert.equal((await fetch(origin+'/voice-waveform.js')).status,200);
  assert.equal((await fetch(origin+'/chat-scroll.js')).status,200);
  assert.equal((await fetch(origin+'/layout.js')).status,200);
  assert.equal((await fetch(origin+'/layout.css')).status,200);
  assert.equal((await fetch(origin+'/input-limits.js')).status,200);
  assert.equal((await fetch(origin+'/markdown.js')).status,200);
  assert.equal((await post('voice-session',{sdp:'v=0\nm=audio'},{'X-Forge-Request':''})).status,403);
  assert.match((await (await post('voice-session',{sdp:'v=0\nm=audio'})).json()).error,/API key/);
  const audioPost=(headers={})=>fetch(origin+'/api/transcribe',{method:'POST',headers:{cookie,'X-Forge-Request':'1','Content-Type':'audio/webm',...headers},body:new Uint8Array()});
  assert.equal((await audioPost({cookie:''})).status,401);
  assert.equal((await audioPost({'X-Forge-Request':''})).status,403);
  assert.match((await (await audioPost()).json()).error,/API key/);
  const folderSelection=await post('project',{path:project,prompt:'open '+project});assert.equal(folderSelection.status,200);
  const selectedState=await (await get('state')).json();const selected=selectedState.sessions.find(s=>s.id===selectedState.activeSessionId);
  assert.equal(selected.root,project);assert.match(selected.messages.at(-1).content,/file contents have not been inspected/);assert.equal(selected.usage.calls,0);
  assert.equal((await (await get('state')).json()).commandMode,'ask');
  assert.equal((await post('command-policy',{mode:'invalid'})).status,400);
  const write=await post('file',{path:'app.txt',content:'Hello',hash:null});assert.equal(write.status,200);const change=await write.json();
  assert.equal((await (await get('file?path=app.txt')).json()).content,'Hello');
  assert.equal((await get('file?path=..%2Foutside.txt')).status,400);
  assert.equal((await post('undo',{id:change.changeId})).status,200);
  await assert.rejects(fs.stat(path.join(project,'app.txt')),/ENOENT/);
  assert.equal((await post('run',{prompt:'Do not call real API in tests.'})).status,400);
  const longPrompt='x'.repeat(40_000);
  assert.match((await (await post('run',{prompt:longPrompt})).json()).error,/API key/); // Length accepted, then missing-key check stops the request locally.
  assert.match((await (await post('run',{prompt:longPrompt+'x'})).json()).error,/40,000 characters.*40,001/);
  const beforeOversize=(await (await get('state')).json()).activeSessionId;
  assert.equal((await post('project',{path:project,prompt:longPrompt+'x'})).status,400);
  assert.equal((await (await get('state')).json()).activeSessionId,beforeOversize);
  assert.equal((await post('project',{path:project,prompt:longPrompt})).status,200);
  const longState=await (await get('state')).json();
  assert.equal(longState.sessions.find(s=>s.id===longState.activeSessionId).messages[0].content,longPrompt);
  assert.match((await (await post('terminal',{command:'x'.repeat(20_001)})).json()).error,/PowerShell.*20,000/);
  async function command(command,allow,{expectApproval=true,switchToAuto=false,stopOnAutomatic=false}={}) {
    const task=await (await post('terminal',{command})).json();assert.ok(task.id);
    const response=await get('events?id='+task.id);const reader=response.body.getReader();let buffer='',all='',approved=false;
    while(true){const {value,done}=await reader.read();if(done)break;const text=new TextDecoder().decode(value);all+=text;buffer+=text;let end;
      while((end=buffer.indexOf('\n\n'))>=0){const part=buffer.slice(0,end);buffer=buffer.slice(end+2);if(part.includes('event: approval\n')){
        const data=JSON.parse(part.split('\n').find(line=>line.startsWith('data: ')).slice(6));assert.equal(approved,false);approved=true;
        assert.equal((await post('project',{path:project})).status,400);
        if(switchToAuto) assert.equal((await post('command-policy',{mode:'auto'})).status,200);
        else assert.equal((await post('approve',{runId:task.id,id:data.id,approved:allow})).status,200);
      }
      if(stopOnAutomatic && part.includes('event: command_auto\n')) assert.equal((await post('stop',{})).status,200);
      }
    }
    assert.equal(approved,expectApproval);return all;
  }
  const accepted=await command("Write-Output 'forge-http-verified'",true);assert.match(accepted,/forge-http-verified/);assert.match(accepted,/"exitCode":0/);
  const rejected=await command("Write-Output 'must-not-execute'",false);assert.match(rejected,/"denied":true/);assert.doesNotMatch(rejected,/event: command_done/);
  const enabledWhileWaiting=await command("Write-Output 'approved-by-project-mode'",true,{switchToAuto:true});assert.match(enabledWhileWaiting,/"exitCode":0/);
  assert.equal((await (await get('state')).json()).commandMode,'auto');
  const automatic=await command("Write-Output 'automatic-command-verified'",true,{expectApproval:false});assert.match(automatic,/event: command_auto/);assert.match(automatic,/"exitCode":0/);assert.doesNotMatch(automatic,/event: approval\n/);
  const stopped=await command('Start-Sleep -Seconds 40',true,{expectApproval:false,stopOnAutomatic:true});assert.match(stopped,/"stopped":true/);
  assert.equal((await post('new-chat',{})).status,200);assert.equal((await (await get('state')).json()).commandMode,'auto');
  const otherProject=path.join(base,'other-project');await fs.mkdir(otherProject);
  assert.equal((await post('project',{path:otherProject})).status,200);assert.equal((await (await get('state')).json()).commandMode,'ask');
  assert.equal((await post('project',{path:project})).status,200);assert.equal((await (await get('state')).json()).commandMode,'auto');
  const goalCreated=await post('goals',{title:'Saved test goal',objective:'Implement a small verified local test feature.',criteria:['Write the feature','Verify it'],allowedRoots:[project,otherProject],readOnlyRoots:[otherProject],maxCycles:2,maxCalls:4});assert.equal(goalCreated.status,200);
  const goal=(await goalCreated.json()).goal;assert.equal(goal.status,'ready');assert.deepEqual(goal.readOnlyRoots,[otherProject]);
  assert.equal((await post('goal-run',{id:goal.id})).status,400); // No key: no model request.
  assert.equal((await post('goal-pause',{id:goal.id})).status,200);assert.equal((await (await get('state')).json()).goals.find(g=>g.id===goal.id).status,'paused');
  const saved=JSON.parse(await fs.readFile(path.join(base,'state','state.json'),'utf8'));assert.ok(saved.trustedProjects.includes(project));assert.ok(!saved.trustedProjects.includes(otherProject));
  assert.equal((await post('command-policy',{mode:'ask'})).status,200);assert.equal((await (await get('state')).json()).commandMode,'ask');
  const reviewedAgain=await command("Write-Output 'review-restored'",true);assert.match(reviewedAgain,/"exitCode":0/);
  const settings=await post('settings',{apiKey:'sk-forge-fake-test-key',model:'gpt-6.1-sol',effort:'low',maxRounds:3,maxOutput:1024});assert.equal(settings.status,200);
  const publicState=await (await get('state')).text();assert.doesNotMatch(publicState,/sk-forge-fake/);assert.match(publicState,/"keyConfigured":true/);
  const stored=await fs.readFile(path.join(base,'state','key.dpapi'),'utf8');assert.ok(!stored.includes('sk-forge'));
  assert.match((await (await audioPost({'Content-Type':'text/html'})).json()).error,/Unsupported recording format/);
  assert.match((await (await audioPost()).json()).error,/No microphone audio/); // Rejected locally: no live provider request.
  assert.match((await (await post('voice-session',{sdp:'invalid'})).json()).error,/valid microphone SDP/);
});
