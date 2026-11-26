import {test} from 'node:test';
import assert from 'node:assert/strict';
import {savedContext,modelToolOutput,compactContext,CONTEXT_HIGH_WATER} from '../lib/agent-context.js';
import {runAgent} from '../lib/agent.js';

test('goal context pins the current revision and keeps successful evidence IDs',()=>{
  const session={messages:[{role:'user',goalId:'g',content:'obsolete objective'},{role:'assistant',content:'old failed run'},{role:'tool',id:'real-test',name:'run_powershell',root:'C:\\project',completed:'2026-11-26T00:00:00Z',result:{exitCode:0,output:'verified'},error:false},{role:'tool',id:'other',name:'read_file',root:'C:\\other',result:{content:'other project data'}},{role:'user',goalId:'g',content:'CURRENT objective and preserved provider cap'}]};
  const content=JSON.stringify(savedContext(session,'C:\\project',true));
  assert.match(content,/CURRENT objective/);assert.match(content,/real-test/);assert.match(content,/tool_succeeded/);
  assert.doesNotMatch(content,/obsolete objective|old failed run|other project data/);
});

test('large tool output is bounded and explicitly incomplete without losing status or evidence ID',()=>{
  const output=modelToolOutput({path:'large.json',hash:'full-file-hash',content:'x'.repeat(280_000)},'real-read','read_file');
  const result=JSON.parse(output);assert(output.length<25_000);assert.equal(result.truncated,true);assert.equal(result.hash,'full-file-hash');assert.equal(result.evidence_id,'real-read');assert.equal(result.tool_succeeded,true);assert.match(result.notice,/Do not infer absence/);
  assert.equal(JSON.parse(modelToolOutput({exitCode:1,output:'failed'},'bad','run_powershell')).tool_succeeded,false);
});

test('context compaction keeps a whole newest call/output batch and encrypted reasoning',()=>{
  const current={role:'user',goalId:'g',content:'Current task; do not reset the 100-request cap.'};
  const frame=[{type:'reasoning',encrypted_content:'opaque-current'},{type:'function_call',name:'read_file',call_id:'new',arguments:'{}'},{type:'function_call_output',call_id:'new',output:'{"evidence_id":"new"}'}];
  const input=[current,{role:'assistant',content:'old data '.repeat(40_000)},...frame];
  assert(compactContext(input,{messages:[current]},'C:\\project',true,frame));
  assert(JSON.stringify(input).length<CONTEXT_HIGH_WATER);assert.equal(input.at(-1).call_id,'new');assert(input.some(x=>x.encrypted_content==='opaque-current'));assert.match(JSON.stringify(input),/100-request cap/);assert.doesNotMatch(JSON.stringify(input),/old data/);
});

test('an oversized complete batch is removed whole rather than leaving orphan tool outputs',()=>{
  const frame=[{type:'function_call',call_id:'huge',arguments:'x'.repeat(400_000)},{type:'function_call_output',call_id:'huge',output:'{}'}];
  const input=[...frame],session={messages:[{role:'user',content:'Continue from saved files.'}]};
  compactContext(input,session,'C:\\project',false,frame);
  assert(input.every(x=>x.type!=='function_call_output'&&x.type!=='function_call'));assert.match(JSON.stringify(input),/Continue from saved files/);
});

test('a long real agent loop continues past the old guard with bounded results and valid call pairs',async()=>{
  const session={messages:[{role:'user',content:'Inspect saved sources and finish the report without resetting any provider budget.'}],usage:{calls:0,input:0,output:0}};
  const events=[];let rounds=0,compacted=false;
  await runAgent({run:{controller:new AbortController()},session,key:'mock',config:{maxRounds:22},workspace:{root:'C:\\project'},approve:async()=>({exitCode:0,output:'large source '.repeat(40_000)}),emit:(type,data)=>{events.push({type,data});if(type==='status'&&data.text.includes('Condensed'))compacted=true;},save:async()=>{},callModel:async request=>{
    rounds++;assert(JSON.stringify(request.input).length<350_000);
    const ids=new Set(request.input.filter(x=>x.type==='function_call').map(x=>x.call_id));
    for(const item of request.input.filter(x=>x.type==='function_call_output')){assert(ids.has(item.call_id));assert.equal(JSON.parse(item.output).evidence_id,item.call_id);}
    if(rounds===20)return {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Report finished from bounded source excerpts.'}]}]};
    return {status:'completed',output:[{type:'reasoning',encrypted_content:'opaque-'+rounds},{type:'function_call',name:'run_powershell',arguments:'{"command":"bounded local check","reason":"Inspect evidence"}',call_id:'tool-'+rounds}]};
  }});
  assert.equal(rounds,20);assert(compacted);assert.equal(events.at(-1).data.status,'complete');assert.equal(session.usage.calls,20);
});
