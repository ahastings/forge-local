import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeGoal,updateGoal,recordCheckpoint,pursueGoal} from '../lib/goals.js';
import {Workspace} from '../lib/workspace.js';

const create=()=>makeGoal({title:'Working goal',objective:'Build a verified local feature.',criteria:['Implement the feature','Verify its behavior'],maxCycles:3,maxCalls:4},'C:\\project');
test('saved goals validate limits and do not start themselves',()=>{
  const goal=create();assert.equal(goal.status,'ready');assert.equal(goal.totalCalls,0);
  assert.throws(()=>makeGoal({objective:'Build a local app',criteria:['Done'],maxCalls:101},'C:\\project'),/API calls/);
  const simple=makeGoal({objective:'Build a local app'},'C:\\project');
  assert.equal(simple.title,'Build a local app');assert.equal(simple.criteria.length,3);assert.equal(simple.status,'ready');assert.equal(simple.totalCalls,0);
  assert.equal(makeGoal({objective:'Build a local app',criteria:[]},'C:\\project').criteria.length,3);
  assert.throws(()=>makeGoal({objective:'Build a local app',criteria:['']},'C:\\project'),/completion criteria/);
});

test('revising scope keeps history and usage but requires new completion evidence',()=>{
  const goal=create();goal.created='2020-01-01T00:00:00.000Z';goal.totalCalls=7;goal.status='complete';goal.criteria.forEach(c=>{c.status='done';c.evidence=['old'];});
  goal.summary='Earlier implementation checked.';goal.checkpoints.push({summary:goal.summary});
  const id=goal.id,created=goal.created;
  updateGoal(goal,{objective:'Extend the feature with a persistent search filter.',expectedRevision:0});
  assert.equal(goal.id,id);assert.equal(goal.created,created);assert.equal(goal.totalCalls,7);assert.equal(goal.status,'paused');
  assert.equal(goal.checkpoints.length,1);assert.equal(goal.revisions[0].criteria[0].status,'done');assert.equal(goal.revisions[0].summary,'Earlier implementation checked.');
  assert(goal.criteria.every(c=>c.status==='pending'&&c.evidence.length===0));assert.equal(goal.revision,1);
  const update={status:'running',summary:'Rechecking.',next_step:'Finish checks.',criteria:[{id:'c1',status:'done',evidence:['old']}]};
  const old={role:'tool',name:'run_powershell',id:'old',root:'C:\\project',completed:'2020-01-02T00:00:00.000Z',result:{exitCode:0},error:false};
  assert.throws(()=>recordCheckpoint(goal,update,[old]),/created or revised/);
  recordCheckpoint(goal,{...update,criteria:[{id:'c1',status:'done',evidence:['new']}]},[{...old,id:'new',completed:new Date(Date.now()+1000).toISOString()}]);
  assert.equal(goal.criteria[0].status,'done');
});

test('renaming or changing run limits preserves completion; stale and running edits are rejected',()=>{
  const goal=create();goal.status='complete';goal.criteria.forEach(c=>{c.status='done';c.evidence=['test'];});
  updateGoal(goal,{title:'Renamed goal',maxCalls:8,expectedRevision:0});
  assert.equal(goal.status,'complete');assert(goal.criteria.every(c=>c.status==='done'));assert.equal(goal.maxCalls,8);
  const snapshot=JSON.stringify(goal);
  assert.throws(()=>updateGoal(goal,{objective:'A stale alternate objective.',expectedRevision:0}),/another window/);
  assert.equal(JSON.stringify(goal),snapshot);
  goal.status='running';assert.throws(()=>updateGoal(goal,{title:'While running',expectedRevision:1}),/Pause/);
});

test('legacy goals can be revised and folder or constraint changes invalidate old checks',()=>{
  const goal=create();delete goal.revision;delete goal.revisions;goal.criteria[0].status='done';
  updateGoal(goal,{constraints:'Keep changes local.',expectedRevision:0});assert.equal(goal.revision,1);assert.equal(goal.criteria[0].status,'pending');
  goal.criteria[0].status='done';updateGoal(goal,{readOnlyRoots:['C:\\reference'],allowedRoots:['C:\\project','C:\\reference'],expectedRevision:1});
  assert.equal(goal.criteria[0].status,'pending');assert.equal(goal.revisions.length,2);
});

test('a simple goal keeps its automatic name in sync until a custom name is supplied',()=>{
  const goal=makeGoal({objective:'Build a small local feature.'},'C:\\project');
  assert.equal(goal.titleAuto,true);
  updateGoal(goal,{objective:'Build a small local feature with search.',expectedRevision:0});
  assert.equal(goal.title,goal.objective);
  updateGoal(goal,{title:'My feature',expectedRevision:1});
  updateGoal(goal,{objective:'Build a small local feature with filters.',expectedRevision:2});
  assert.equal(goal.title,'My feature');assert.equal(goal.titleAuto,false);
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
