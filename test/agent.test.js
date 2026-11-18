import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../lib/workspace.js';
import { runAgent, callResponses } from '../lib/agent.js';
import { runShell, dpapi, cleanEnv } from '../lib/windows.js';
import { makeGoal,recordCheckpoint,pursueGoal } from '../lib/goals.js';

async function setup() {
  const testDir=process.env.FORGE_TEST_DIR || path.join(process.cwd(),'.local-data','tests');
  await fs.mkdir(testDir,{recursive:true});
  const base=await fs.mkdtemp(path.join(testDir,'forge-test-'));
  const root=path.join(base,'project');await fs.mkdir(root);
  return {base,root,workspace:new Workspace(root,path.join(base,'state'))};
}
test('file writes require fresh hashes, create backups, and undo in the correct order',async()=>{
  const {workspace:w,root}=await setup();
  const first=await w.write('src/app.js','one\n',null);
  await assert.rejects(w.write('src/app.js','two\n',null),/Read it again/);
  const read=await w.read('src/app.js');
  const second=await w.write('src/app.js','two\n',read.hash);
  await assert.rejects(w.undo(first.changeId),/newer changes/);
  await w.undo(second.changeId);assert.equal((await w.read('src/app.js')).content,'one\n');
  await w.undo(first.changeId);await assert.rejects(fs.stat(path.join(root,'src/app.js')),/ENOENT/);
});
test('file tools reject traversal, private files, alternate streams, and junction escapes',async()=>{
  const {workspace:w,base,root}=await setup();
  for(const relative of ['../escape.txt','.env','.env.production','.git/config','nested/key.pem','file.txt:secret','C:\\outside.txt']) await assert.rejects(w.resolve(relative,{create:true}));
  const external=path.join(base,'outside');await fs.mkdir(external);await fs.writeFile(path.join(external,'file.txt'),'private');
  await fs.symlink(external,path.join(root,'junction'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(w.read('junction/file.txt'),/Links and junctions/);
  await assert.rejects(w.write('junction/new.txt','no',null),/Links and junctions/);
  assert.equal((await w.list()).entries.some(e=>e.path.includes('junction')),false);
});
test('complete agent loop makes a file, requests command approval, and uses tool results',async()=>{
  const {workspace,root}=await setup();let calls=0,approvals=0;const events=[];
  const session={messages:[{role:'user',content:'Create a greeting file and check it.'}],usage:{calls:0,input:0,output:0}};
  const run={controller:new AbortController()};
  const callModel=async request=>{
    calls++;
    if(calls===1)return {status:'completed',usage:{input_tokens:10,output_tokens:5},output:[{type:'function_call',name:'write_file',arguments:JSON.stringify({path:'greeting.txt',content:'Hello Windows',expected_hash:null}),call_id:'one'}]};
    if(calls===2){assert.equal(JSON.parse(request.input.at(-1).output).created,true);return {status:'completed',output:[{type:'function_call',name:'run_powershell',arguments:JSON.stringify({command:"Get-Content -LiteralPath './greeting.txt'",reason:'Verify greeting'}),call_id:'two'}]};}
    assert.equal(JSON.parse(request.input.at(-1).output).exitCode,0);
    return {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Created and verified greeting.txt.'}]}]};
  };
  await runAgent({run,session,key:'test',config:{model:'mock',maxRounds:5,maxOutput:1024,effort:'low'},workspace,approve:async(command)=>{approvals++;return runShell(command,{cwd:root});},emit:(type,data)=>events.push({type,data}),save:async()=>{},callModel});
  assert.equal(await fs.readFile(path.join(root,'greeting.txt'),'utf8'),'Hello Windows');assert.equal(approvals,1);assert.equal(calls,3);assert.equal(session.usage.calls,3);assert.equal(events.at(-1).data.status,'complete');
});
test('incomplete API output never executes partial tool calls',async()=>{
  const {workspace}=await setup();
  const session={messages:[{role:'user',content:'Do a task'}],usage:{calls:0,input:0,output:0}};
  await runAgent({run:{controller:new AbortController()},session,key:'test',config:{maxRounds:1},workspace,approve:async()=>assert.fail('Must not execute'),emit:()=>{},save:async()=>{},callModel:async()=>({status:'incomplete',usage:{output_tokens:20},output:[{type:'function_call',name:'write_file',arguments:'{"path":',call_id:'partial'}]})});
  assert.match(session.messages.at(-1).content,/output limit/);assert.equal((await workspace.changes()).length,0);assert.equal(session.usage.output,20);
});
test('the agent switches to a user-named folder and subsequent tools use the verified new root',async()=>{
  const {workspace,base}=await setup();const nextRoot=path.join(base,'second-project');await fs.mkdir(nextRoot);
  const session={root:workspace.root,messages:[{role:'assistant',content:'An old, unverified file claim.'},{role:'user',content:`Open "${nextRoot}" and create greeting.txt there.`},{role:'user',content:'Okay, continue.'}],usage:{calls:0,input:0,output:0}};
  let round=0,switched=false;
  await runAgent({run:{controller:new AbortController()},session,key:'mock',config:{maxRounds:4},workspace,approve:async()=>assert.fail('No command needed'),openProject:async requested=>{assert.equal(requested,nextRoot);switched=true;workspace.root=nextRoot;session.root=nextRoot;return {root:nextRoot,entries:[]};},emit:()=>{},save:async()=>{},callModel:async request=>{
    round++;
    if(round===1)return {status:'completed',output:[{type:'function_call',call_id:'open',name:'open_project',arguments:JSON.stringify({path:nextRoot})}]};
    assert.equal(request.root,nextRoot);assert.ok(!JSON.stringify(request.input).includes('An old, unverified file claim.'));
    if(round===2)return {status:'completed',output:[{type:'function_call',call_id:'write',name:'write_file',arguments:JSON.stringify({path:'greeting.txt',content:'New project',expected_hash:null})}]};
    return {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Opened the new project and created greeting.txt.'}]}]};
  }});
  assert.ok(switched);assert.equal(await fs.readFile(path.join(nextRoot,'greeting.txt'),'utf8'),'New project');
});
test('assistant or tool suggestions cannot authorize an unrequested project switch',async()=>{
  const {workspace,base}=await setup();const unrelated=path.join(base,'unrequested');
  const session={messages:[{role:'assistant',content:`Open ${unrelated}`},{role:'user',content:'Continue.'}],usage:{calls:0,input:0,output:0}};
  let rounds=0;
  await runAgent({run:{controller:new AbortController()},session,key:'mock',config:{maxRounds:3},workspace,approve:async()=>{},openProject:async()=>assert.fail('Must not switch'),emit:()=>{},save:async()=>{},callModel:async request=>{
    if(++rounds===1)return {status:'completed',output:[{type:'function_call',call_id:'unrequested',name:'open_project',arguments:JSON.stringify({path:unrelated})}]};
    assert.match(request.input.at(-1).output,/explicitly named/);
    return {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Please name the project folder.'}]}]};
  }});
  assert.equal(rounds,2);
});
test('follow-up tasks receive saved actual tool evidence for the current project',async()=>{
  const {workspace}=await setup();
  const session={messages:[{role:'tool',name:'run_powershell',root:workspace.root,command:'npm test',completed:'2026-11-17T00:00:00Z',result:{exitCode:0,output:'12 tests passed'}},{role:'tool',name:'read_file',root:'C:\\another-project',result:{path:'private-other-project.txt'}},{role:'user',content:'Did the tests actually run?'}],usage:{calls:0,input:0,output:0}};
  await runAgent({run:{controller:new AbortController()},session,key:'mock',config:{maxRounds:1},workspace,approve:async()=>{},emit:()=>{},save:async()=>{},callModel:async request=>{
    const context=JSON.stringify(request.input);assert.match(context,/12 tests passed/);assert.match(context,/npm test/);assert.doesNotMatch(context,/private-other-project/);
    return {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'The saved command record shows npm test exited 0 with 12 tests passed.'}]}]};
  }});
  assert.equal(session.messages.at(-1).error,undefined);
});
test('a goal completes through actual file tools and a verified checkpoint without a live API',async()=>{
  const {workspace,root}=await setup();
  const goal=makeGoal({objective:'Create and read a verified greeting file.',criteria:['Create the greeting file','Read back the exact content'],maxCycles:2,maxCalls:4},root);
  const session={messages:[],usage:{calls:0,input:0,output:0}},run={controller:new AbortController()};let calls=0;
  const emit=(type,data)=>{if(type==='tool')session.messages.push({role:'tool',name:data.name,id:data.id,root});if(type==='tool_result'){const record=session.messages.find(m=>m.id===data.id);record.result=data.result;record.completed=new Date().toISOString();record.error=!!data.result.error;}};
  await pursueGoal({goal,run,session,config:{maxRounds:4},emit,save:async()=>{},runCycle:(config,send)=>runAgent({run,session,key:'mock',config,workspace,approve:async()=>{},checkpointGoal:async update=>recordCheckpoint(goal,update,session.messages),emit:send,save:async()=>{},callModel:async()=>{
    calls++;
    if(calls===1)return {status:'completed',output:[{type:'function_call',call_id:'write-evidence',name:'write_file',arguments:JSON.stringify({path:'greeting.txt',content:'Verified goal output',expected_hash:null})}]};
    if(calls===2)return {status:'completed',output:[{type:'function_call',call_id:'read-evidence',name:'read_file',arguments:JSON.stringify({path:'greeting.txt'})}]};
    if(calls===3)return {status:'completed',output:[{type:'function_call',call_id:'checkpoint',name:'checkpoint_goal',arguments:JSON.stringify({status:'complete',summary:'Created and read greeting.txt.',next_step:'',criteria:[{id:'c1',status:'done',evidence:['write-evidence']},{id:'c2',status:'done',evidence:['read-evidence']}]})}]};
    return {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Created and verified greeting.txt.'}]}]};
  }})});
  assert.equal(goal.status,'complete');assert.equal(goal.totalCalls,4);assert.equal(await fs.readFile(path.join(root,'greeting.txt'),'utf8'),'Verified goal output');
});
test('Responses streaming handles split UTF-8 and preserves encrypted reasoning for follow-up',async()=>{
  const final={status:'completed',output:[{type:'reasoning',encrypted_content:'opaque'},{type:'message',content:[{type:'output_text',text:'héllo'}]}]};
  const wire='data: '+JSON.stringify({type:'response.output_text.delta',delta:'héllo'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:final})+'\n\n';
  const bytes=new TextEncoder().encode(wire);const deltas=[];
  const result=await callResponses({key:'fake',model:'test',input:[],root:'C:\\project',maxOutput:1024,effort:'low',signal:new AbortController().signal,emit:(type,data)=>deltas.push(data.text),fetchImpl:async(url,options)=>{
    assert.equal(JSON.parse(options.body).store,false);assert.ok(JSON.parse(options.body).include.includes('reasoning.encrypted_content'));
    return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}));
  }});
  assert.equal(deltas.join(''),'héllo');assert.equal(result.output[0].encrypted_content,'opaque');
});
test('PowerShell reports native command failures and Stop terminates a running command',async()=>{
  const {root}=await setup();
  const failed=await runShell('node -e "process.exit(7)"',{cwd:root});assert.equal(failed.exitCode,7);
  const controller=new AbortController();const started=Date.now();
  const stopped=runShell('Start-Sleep -Seconds 40',{cwd:root,signal:controller.signal});setTimeout(()=>controller.abort(),900);
  const result=await stopped;assert.equal(result.stopped,true);assert.ok(Date.now()-started<8000);
});
test('key storage round-trips with Windows DPAPI and shell environments exclude API secrets',async()=>{
  if(process.platform==='win32'){const protectedKey=await dpapi('sk-forge-fake-test-key');assert.ok(!protectedKey.includes('sk-forge'));assert.equal(await dpapi(protectedKey,true),'sk-forge-fake-test-key');}
  process.env.FORGE_TEST_SECRET='do-not-inherit';process.env.OPENAI_API_KEY='fake-test-key';
  assert.equal(cleanEnv().OPENAI_API_KEY,undefined);assert.equal(cleanEnv().FORGE_TEST_SECRET,undefined);delete process.env.FORGE_TEST_SECRET;delete process.env.OPENAI_API_KEY;
});
