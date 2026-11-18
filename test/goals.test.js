import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeGoal,recordCheckpoint,pursueGoal} from '../lib/goals.js';
import {Workspace} from '../lib/workspace.js';

const create=()=>makeGoal({title:'Working goal',objective:'Build a verified local feature.',criteria:['Implement the feature','Verify its behavior'],maxCycles:3,maxCalls:4},'C:\\project');
test('saved goals validate limits and do not start themselves',()=>{
  const goal=create();assert.equal(goal.status,'ready');assert.equal(goal.totalCalls,0);
  assert.throws(()=>makeGoal({objective:'Build a local app',criteria:['Done'],maxCalls:101},'C:\\project'),/API calls/);
  assert.throws(()=>makeGoal({objective:'Build a local app',criteria:[]},'C:\\project'),/completion criteria/);
});
test('goal completion requires real successful evidence for every criterion',()=>{
  const goal=create();const completed=new Date(Date.now()+1000).toISOString();
  const messages=[{role:'tool',name:'write_file',id:'write',root:'C:\\project',completed,result:{path:'app.js'},error:false},{role:'tool',name:'run_powershell',id:'test',root:'C:\\project',completed,result:{exitCode:0,output:'Passed'},error:false},{role:'tool',name:'run_powershell',id:'fail',root:'C:\\project',completed,result:{exitCode:1},error:true},{role:'tool',name:'checkpoint_goal',id:'self',root:'C:\\project',completed,result:{ok:true}}];
  const update={status:'complete',summary:'Built and checked.',next_step:'',criteria:[{id:'c1',status:'done',evidence:['write']},{id:'c2',status:'done',evidence:['invented']}]};
  assert.throws(()=>recordCheckpoint(goal,update,messages),/actual successful/);
  assert.equal(goal.criteria[0].status,'pending');
  for(const evidence of [['fail'],['self']])assert.throws(()=>recordCheckpoint(goal,{...update,criteria:[{id:'c1',status:'done',evidence}]},messages),/actual successful/);
  recordCheckpoint(goal,{...update,criteria:[{id:'c1',status:'done',evidence:['write']},{id:'c2',status:'done',evidence:['test']}]},messages);
  assert.equal(goal.status,'complete');assert.equal(goal.checkpoints.length,1);
});
test('goal runs stop at the shared API-call cap and leave a resumable checkpoint',async()=>{
  const goal=create(),run={controller:new AbortController()},session={usage:{calls:0},messages:[]};let cycles=0;
  await pursueGoal({goal,run,session,config:{maxRounds:12},runCycle:async(config,emit)=>{cycles++;assert.equal(config.maxRounds,4);session.usage.calls+=4;goal.summary='First part saved.';emit('done',{status:'round_limit'});},emit:()=>{},save:async()=>{}});
  assert.equal(cycles,1);assert.equal(goal.status,'limit_reached');assert.equal(goal.totalCalls,4);assert.equal(goal.summary,'First part saved.');
  const nextRun={controller:new AbortController()};
  await pursueGoal({goal,run:nextRun,session,config:{maxRounds:2},runCycle:async(config,emit)=>{session.usage.calls++;goal.status='blocked';goal.summary='Needs an external source identifier.';emit('done',{status:'complete'});},emit:()=>{},save:async()=>{}});
  assert.equal(goal.status,'blocked');assert.equal(goal.totalCalls,5);
});
test('pausing a goal prevents another work cycle',async()=>{
  const goal=create(),run={controller:new AbortController()},session={usage:{calls:0},messages:[]};let cycles=0;
  await pursueGoal({goal,run,session,config:{maxRounds:2},runCycle:async(config,emit)=>{cycles++;run.controller.abort();emit('done',{status:'stopped'});},emit:()=>{},save:async()=>{}});
  assert.equal(cycles,1);assert.equal(goal.status,'paused');
});
test('reference workspace file mutations are blocked',async()=>{
  const ws=new Workspace('C:\\reference','C:\\data');ws.readOnly=true;
  await assert.rejects(ws.write('anything.txt','x',null),/read-only reference/);await assert.rejects(ws.undo('id'),/read-only reference/);
});
