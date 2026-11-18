import crypto from 'node:crypto';

export function makeGoal(data, root) {
  const objective=String(data.objective||'').trim();
  if(objective.length<10||objective.length>20000)throw new Error('Use a goal between 10 and 20,000 characters.');
  const criteria=Array.isArray(data.criteria)?data.criteria.map(c=>typeof c==='string'?c:c.text):[];
  if(!criteria.length||criteria.length>12||criteria.some(c=>typeof c!=='string'||!c.trim()||c.length>2500))throw new Error('Add 1–12 clear completion criteria.');
  const maxCycles=Number(data.maxCycles??3),maxCalls=Number(data.maxCalls??24);
  if(!Number.isInteger(maxCycles)||maxCycles<1||maxCycles>10||!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>100)throw new Error('Use 1–10 work cycles and 1–100 API calls per run.');
  return {id:crypto.randomUUID(),title:String(data.title||objective.slice(0,70)).slice(0,120),objective,constraints:String(data.constraints||'').slice(0,16000),primaryRoot:root,allowedRoots:[root],readOnlyRoots:[],criteria:criteria.map((text,i)=>({id:'c'+(i+1),text:text.trim(),status:'pending',evidence:[]})),maxCycles,maxCalls,status:'ready',summary:'Not started.',nextStep:'Inspect the project instructions and current state first.',checkpoints:[],created:new Date().toISOString(),totalCalls:0};
}
export function recordCheckpoint(goal, update, messages) {
  if(!['running','complete','blocked'].includes(update.status))throw new Error('Invalid goal status.');
  if(typeof update.summary!=='string'||!update.summary.trim()||typeof update.next_step!=='string')throw new Error('Include a summary and next step.');
  const proposed=structuredClone(goal.criteria);
  for(const change of update.criteria||[]) {
    const criterion=proposed.find(c=>c.id===change.id);
    if(!criterion||!['pending','done','blocked'].includes(change.status))throw new Error('Use the saved criterion IDs and valid statuses.');
    const ids=Array.isArray(change.evidence)?change.evidence:[];
    if(change.status==='done' && (!ids.length||ids.some(id=>!messages.some(m=>m.role==='tool'&&m.name!=='checkpoint_goal'&&m.id===id&&m.result&&m.completed>=goal.created&&!m.error&&goal.allowedRoots.includes(m.root)))))throw new Error('A completed criterion needs IDs of actual successful tool results from an allowed project after the goal was created.');
    criterion.status=change.status;criterion.evidence=ids;
  }
  if(update.status==='complete'&&proposed.some(c=>c.status!=='done'))throw new Error('Every completion criterion must have verified tool evidence before completing the goal.');
  goal.criteria=proposed;goal.status=update.status;goal.summary=update.summary.slice(0,6000);goal.nextStep=update.next_step.slice(0,6000);
  goal.checkpoints.push({time:new Date().toISOString(),status:goal.status,summary:goal.summary,nextStep:goal.nextStep});
  if(goal.checkpoints.length>40)goal.checkpoints=goal.checkpoints.slice(-40);
  return {id:goal.id,status:goal.status,criteria:goal.criteria,nextStep:goal.nextStep};
}
export function goalPrompt(goal,cycle) {
  return `Work toward this saved goal, cycle ${cycle}. Complete the highest-priority unfinished work using actual tool results. Continue independent work without repeatedly asking to proceed.\n\nGOAL: ${goal.title}\n${goal.objective}\n\nCONSTRAINTS:\n${goal.constraints}\n\nALLOWED PROJECT FOLDERS (these paths are authorized for open_project):\n${goal.allowedRoots.join('\n')}\nREAD-ONLY REFERENCE FOLDERS (file writes and PowerShell are disabled there):\n${goal.readOnlyRoots.join('\n')||'None'}\n\nCOMPLETION CRITERIA:\n${goal.criteria.map(c=>`${c.id} [${c.status}] ${c.text}`).join('\n')}\n\nLAST CHECKPOINT:\n${goal.summary}\nNEXT STEP:\n${goal.nextStep}\n\nCall checkpoint_goal to record progress before ending this work cycle. Mark criteria done only with IDs of real successful tool results (IDs appear in tool calls). Mark complete only when every criterion is satisfied. If an external dependency blocks the remaining work, mark blocked and explain the exact missing input. Do not claim success based only on your own earlier answer. API calls are bounded; leave a precise checkpoint if the run limit is reached.`;
}
export async function pursueGoal({goal,run,session,config,runCycle,emit,save}) {
  const startedCalls=session.usage.calls;
  goal.status='running';goal.lastRunStarted=new Date().toISOString();await save();emit('goal',goal);
  try {
    for(let cycle=1;cycle<=goal.maxCycles;cycle++) {
      if(run.controller.signal.aborted){goal.status='paused';break;}
      const remaining=goal.maxCalls-(session.usage.calls-startedCalls);
      if(remaining<=0){goal.status='limit_reached';break;}
      goal.currentCycle=cycle;
      session.messages.push({role:'user',content:goalPrompt(goal,cycle),time:new Date().toISOString(),goalId:goal.id});await save();
      emit('status',{text:`Goal cycle ${cycle}/${goal.maxCycles} · ${remaining} API calls available`});
      let cycleStatus;
      await runCycle({...config,maxRounds:Math.min(config.maxRounds,remaining)},(type,data)=>{
        if(type==='done'){cycleStatus=data.status;return;}
        if(type==='error'&&data.code==='ROUND_LIMIT')return;
        emit(type,data);
      });
      if(run.controller.signal.aborted){goal.status='paused';break;}
      if(goal.status==='complete'||goal.status==='blocked')break;
      if(cycleStatus==='failed'||cycleStatus==='stopped'){goal.status=cycleStatus==='stopped'?'paused':'failed';break;}
      if(cycle===goal.maxCycles)goal.status='limit_reached';
      await save();emit('goal',goal);
    }
  } catch(error) {goal.status=run.controller.signal.aborted?'paused':'failed';goal.summary=error.message;emit('error',{text:error.message});}
  finally {
    goal.totalCalls+=session.usage.calls-startedCalls;goal.lastRunEnded=new Date().toISOString();await save();emit('goal',goal);
    emit('done',{status:goal.status==='complete'?'complete':goal.status==='paused'?'stopped':goal.status});
  }
}
