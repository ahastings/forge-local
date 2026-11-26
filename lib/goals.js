import crypto from 'node:crypto';

const defaultCriteria = [
  'Deliver the requested outcome and satisfy the requirements in the goal.',
  'Run relevant checks, fix introduced failures, and record any verification that could not be performed.',
  'Save a concise handoff with the changes, verification evidence, usage instructions where relevant, and remaining blockers.'
];

export function makeGoal(data, root) {
  const objective=String(data.objective||'').trim();
  if(objective.length<10||objective.length>20000)throw new Error('Use a goal between 10 and 20,000 characters.');
  if(data.criteria!==undefined&&!Array.isArray(data.criteria))throw new Error('Use a list of completion criteria.');
  const criteria=data.criteria?.length?data.criteria.map(c=>typeof c==='string'?c:c?.text):defaultCriteria;
  if(!criteria.length||criteria.length>12||criteria.some(c=>typeof c!=='string'||!c.trim()||c.length>2500))throw new Error('Add 1–12 clear completion criteria.');
  const maxCycles=Number(data.maxCycles??3),maxCalls=Number(data.maxCalls??24);
  if(!Number.isInteger(maxCycles)||maxCycles<1||maxCycles>10||!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>100)throw new Error('Use 1–10 work cycles and 1–100 API calls per run.');
  return {id:crypto.randomUUID(),title:String(data.title||'').trim().slice(0,120)||objective.replace(/\s+/g,' ').slice(0,70),titleAuto:!String(data.title||'').trim(),objective,constraints:String(data.constraints||'').slice(0,16000),primaryRoot:root,allowedRoots:[root],readOnlyRoots:[],criteria:criteria.map((text,i)=>({id:'c'+(i+1),text:text.trim(),status:'pending',evidence:[]})),maxCycles,maxCalls,status:'ready',summary:'Not started.',nextStep:'Inspect the project instructions and current state first.',checkpoints:[],created:new Date().toISOString(),totalCalls:0,revision:0,revisions:[]};
}

export function updateGoal(goal, data) {
  if(goal.status==='running')throw new Error('Pause the goal and wait for the run to stop before editing it.');
  if(data.expectedRevision!==(goal.revision||0))throw new Error('This goal changed in another window. Reopen it before saving.');
  const draft=makeGoal({...goal,title:goal.titleAuto?'':goal.title,criteria:goal.criteria.map(c=>c.text),...data},goal.primaryRoot);
  const allowedRoots=data.allowedRoots??goal.allowedRoots,readOnlyRoots=data.readOnlyRoots??goal.readOnlyRoots;
  const scopeChanged=draft.objective!==goal.objective||draft.constraints!==goal.constraints||JSON.stringify(draft.criteria.map(c=>c.text))!==JSON.stringify(goal.criteria.map(c=>c.text))||JSON.stringify(allowedRoots)!==JSON.stringify(goal.allowedRoots)||JSON.stringify(readOnlyRoots)!==JSON.stringify(goal.readOnlyRoots);
  if(!scopeChanged&&draft.title===goal.title&&draft.titleAuto===!!goal.titleAuto&&draft.maxCycles===goal.maxCycles&&draft.maxCalls===goal.maxCalls)return goal;
  const now=new Date().toISOString();
  const previous={revision:goal.revision||0,time:now,title:goal.title,objective:goal.objective,constraints:goal.constraints,criteria:structuredClone(goal.criteria),allowedRoots:[...goal.allowedRoots],readOnlyRoots:[...goal.readOnlyRoots],maxCycles:goal.maxCycles,maxCalls:goal.maxCalls,status:goal.status,summary:goal.summary,nextStep:goal.nextStep};
  goal.revisions=[...(goal.revisions||[]),previous].slice(-20);
  Object.assign(goal,{title:draft.title,titleAuto:draft.titleAuto,objective:draft.objective,constraints:draft.constraints,maxCycles:draft.maxCycles,maxCalls:draft.maxCalls,allowedRoots,readOnlyRoots,revision:(goal.revision||0)+1,updated:now});
  if(scopeChanged){
    goal.criteria=draft.criteria;
    goal.verificationSince=now;
    goal.status=goal.totalCalls?'paused':'ready';
    goal.nextStep='The goal changed. Re-read the revised objective and current files, then verify the completion checks again. Previous checkpoints are historical context.';
  }
  return goal;
}
export function recordCheckpoint(goal, update, messages) {
  if(!['running','complete','blocked'].includes(update.status))throw new Error('Invalid goal status.');
  if(typeof update.summary!=='string'||!update.summary.trim()||typeof update.next_step!=='string')throw new Error('Include a summary and next step.');
  const proposed=structuredClone(goal.criteria);
  for(const change of update.criteria||[]) {
    const criterion=proposed.find(c=>c.id===change.id);
    if(!criterion||!['pending','done','blocked'].includes(change.status))throw new Error('Use the saved criterion IDs and valid statuses.');
    const ids=Array.isArray(change.evidence)?change.evidence:[];
    if(change.status==='done' && (!ids.length||ids.some(id=>!messages.some(m=>m.role==='tool'&&m.name!=='checkpoint_goal'&&m.id===id&&m.result&&m.completed>=(goal.verificationSince||goal.created)&&!m.error&&goal.allowedRoots.includes(m.root)))))throw new Error('A completed criterion needs IDs of actual successful tool results from an allowed project after the goal was created or revised.');
    criterion.status=change.status;criterion.evidence=ids;
  }
  if(update.status==='complete'&&proposed.some(c=>c.status!=='done'))throw new Error('Every completion criterion must have verified tool evidence before completing the goal.');
  goal.criteria=proposed;goal.status=update.status;goal.summary=update.summary.slice(0,6000);goal.nextStep=update.next_step.slice(0,6000);
  goal.checkpoints.push({time:new Date().toISOString(),status:goal.status,summary:goal.summary,nextStep:goal.nextStep});
  if(goal.checkpoints.length>40)goal.checkpoints=goal.checkpoints.slice(-40);
  return {id:goal.id,status:goal.status,criteria:goal.criteria,nextStep:goal.nextStep};
}
export function goalPrompt(goal,cycle) {
  return `Work toward this saved goal, cycle ${cycle}, revision ${goal.revision||0}. Complete the highest-priority unfinished work using actual tool results. Continue independent work without repeatedly asking to proceed.\n\nGOAL: ${goal.title}\n${goal.objective}\n\nCONSTRAINTS:\n${goal.constraints}\n\nALLOWED PROJECT FOLDERS (these paths are authorized for open_project):\n${goal.allowedRoots.join('\n')}\nREAD-ONLY REFERENCE FOLDERS (file writes and PowerShell are disabled there):\n${goal.readOnlyRoots.join('\n')||'None'}\n\nCOMPLETION CRITERIA:\n${goal.criteria.map(c=>`${c.id} [${c.status}] ${c.text}`).join('\n')}\n\nLAST CHECKPOINT (historical context; current requirements take precedence):\n${goal.summary}\nNEXT STEP:\n${goal.nextStep}\n\nCall checkpoint_goal to record progress before ending this work cycle. Mark criteria done only with IDs of real successful tool results (IDs appear in tool calls). Mark complete only when every criterion is satisfied. If an external dependency blocks the remaining work, mark blocked and explain the exact missing input. Do not claim success based only on your own earlier answer. API calls are bounded; leave a precise checkpoint if the run limit is reached.`;
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
