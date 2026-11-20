import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Workspace, projectRoot, atomicJson } from './lib/workspace.js';
import { runShell, dpapi, browseFolder } from './lib/windows.js';
import { runAgent } from './lib/agent.js';
import { makeGoal, recordCheckpoint, pursueGoal } from './lib/goals.js';
import { readAudio, transcribeAudio } from './lib/transcription.js';
import { createTranscriptionCall } from './lib/live-transcription.js';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.FORGE_DATA_DIR || path.join(appDir,'.local-data');
await fs.mkdir(dataDir,{recursive:true});
// Load this app's .env explicitly. Never copy unrelated shared credentials.
try {
  const env = process.env.FORGE_SKIP_ENV_FILE === '1' ? '' : await fs.readFile(path.join(appDir,'.env'),'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*(OPENAI_API_KEY|PORT)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/,'$2');
  }
} catch (e) { if(e.code!=='ENOENT') throw e; }
const port = Number(process.env.PORT || 4317);
const origin = `http://127.0.0.1:${port}`;
const sessionCookie = crypto.randomBytes(32).toString('hex');
const defaults = {model:'gpt-6.1-sol',effort:'low',maxRounds:12,maxOutput:8192};
let state;
try { state = JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; }
state ||= {config:defaults,sessions:[],activeSessionId:null}; state.config = {...defaults,...state.config};
state.goals=Array.isArray(state.goals)?state.goals:[];
for(const goal of state.goals)if(goal.status==='running'){goal.status='paused';goal.summary='The app restarted. Resume from the saved checkpoint and current project files.';}
state.trustedProjects = Array.isArray(state.trustedProjects) ? state.trustedProjects.filter(root=>typeof root==='string') : [];
const sameProject = (a,b) => process.platform==='win32' ? a.toLowerCase()===b.toLowerCase() : a===b;
const commandMode = root => root && state.trustedProjects.some(folder=>sameProject(folder,root)) ? 'auto' : 'ask';
let apiKey = process.env.OPENAI_API_KEY || '';
let keySource = apiKey ? 'environment' : 'none';
if (!apiKey) {
  try { apiKey = await dpapi(await fs.readFile(path.join(dataDir,'key.dpapi'),'utf8'),true); keySource='Windows encrypted storage'; }
  catch(e) { if(e.code!=='ENOENT') console.error('Saved key could not be unlocked. Re-enter it in Settings.'); }
}
let saveQueue = Promise.resolve();
const save = () => { const snapshot=structuredClone(state); const next=saveQueue.catch(()=>{}).then(()=>atomicJson(path.join(dataDir,'state.json'),snapshot)); saveQueue=next; return next; };
let run = null;
let transcribing = false;
const runs = new Map();
const redact = value => {
  let text = JSON.stringify(value);
  if (apiKey) text=text.split(apiKey).join('[API KEY REDACTED]');
  return JSON.parse(text);
};
const activeSession = () => state.sessions.find(s=>s.id===state.activeSessionId);
const requireIdle = () => { if(run && !run.finished) throw new Error('Stop the active task before changing projects, settings, or files.'); };
function emit(task,type,data) {
  const event = {id:task.events.length+1,type,data:redact(data)}; task.events.push(event);
  if(type==='tool' && (task.kind==='agent'||task.kind==='goal')) {
    const session=state.sessions.find(s=>s.id===task.sessionId);
    session?.messages.push({role:'tool',id:data.id,name:data.name,root:session.root,command:event.data.args?.command,content:'› '+data.name.replaceAll('_',' ')+'  '+(data.args?.path||data.args?.query||data.args?.reason||''),time:new Date().toISOString()});
    void save().catch(()=>{});
  }
  if(type==='tool_result' && (task.kind==='agent'||task.kind==='goal')) {
    const session=state.sessions.find(s=>s.id===task.sessionId);
    const record=session?.messages.findLast(m=>m.role==='tool'&&m.id===data.id);
    if(record) {
      const result=structuredClone(event.data.result);
      if(typeof result.output==='string'&&result.output.length>12000) {result.output=result.output.slice(0,12000)+'\n[Saved output truncated]';result.savedOutputTruncated=true;}
      if(Array.isArray(result.entries)&&result.entries.length>80) {result.entries=result.entries.slice(0,80);result.savedListingTruncated=true;}
      if(Array.isArray(result.matches)&&result.matches.length>40) {result.matches=result.matches.slice(0,40);result.savedMatchesTruncated=true;}
      record.result=result;record.root=session.root;record.completed=new Date().toISOString();
      record.error=!!(result.error||result.denied||result.timedOut||result.stopped||(result.exitCode!==undefined&&result.exitCode!==0));
      record.content+=' · '+(result.denied?'declined':result.error?'error':result.timedOut?'timed out':result.stopped?'stopped':result.exitCode!==undefined?'exit '+result.exitCode:'completed');
      void save().catch(()=>{});
    }
  }
  const payload=`id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for(const client of task.clients) client.write(payload);
}
function createRun(kind,session) {
  requireIdle();
  run = {id:crypto.randomUUID(),sessionId:session.id,kind,events:[],clients:new Set(),controller:new AbortController(),finished:false,approval:null};
  runs.set(run.id,run);
  if(runs.size>15) { const old=[...runs.entries()].find(([,r])=>r.finished && !r.clients.size); if(old) runs.delete(old[0]); }
  return run;
}
function workspace(session,task) { return new Workspace(session.root,dataDir,change=>{ if(task) emit(task,'change',change); }); }
async function commandApproval(task,ws,command,reason) {
  if(task.controller.signal.aborted) throw new Error('Stopped.');
  if(ws.readOnly)throw new Error('PowerShell is disabled in this goal’s read-only reference folder. Use file tools or switch back to the primary project.');
  const automatic = commandMode(ws.root)==='auto';
  const approved = automatic || await new Promise(resolve=>{
    const id=crypto.randomUUID();
    const finish=value=>{ clearTimeout(timer); task.controller.signal.removeEventListener('abort',abort); task.approval=null; resolve(value); };
    const abort=()=>finish(false);
    const timer=setTimeout(()=>finish(false),15*60_000);
    task.approval={id,command,reason,resolve:finish};
    task.controller.signal.addEventListener('abort',abort,{once:true});
    emit(task,'approval',{id,command,reason,cwd:ws.root});
  });
  if(!approved) { emit(task,'approval_resolved',{approved:false}); return {denied:true,message:'The user declined this command, or the request expired. Do not retry it another way.'}; }
  task.controller.signal.throwIfAborted();
  // Revalidate the root immediately before execution.
  await ws.resolve('.');
  if(automatic) emit(task,'command_auto',{command,reason,cwd:ws.root});
  emit(task,'approval_resolved',{approved:true}); emit(task,'status',{text:'Running PowerShell'});
  const result=await runShell(command,{cwd:ws.root,signal:task.controller.signal,onOutput:data=>emit(task,'terminal',data)});
  emit(task,'command_done',{exitCode:result.exitCode,timedOut:result.timedOut,stopped:result.stopped});
  return redact(result);
}
function finishRun(task) {
  task.finished=true;
  for(const client of task.clients) client.end(); task.clients.clear();
}
async function body(req) {
  if(!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON request required.');
  let bytes=0,chunks=[];
  for await(const chunk of req) { bytes+=chunk.length; if(bytes>1_000_000) throw new Error('Request exceeds 1 MB.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(redact(value)));};
function newSession(root) {
  const s={id:crypto.randomUUID(),root,title:'New task',messages:[],usage:{calls:0,input:0,output:0},created:new Date().toISOString()};
  state.sessions.unshift(s); state.activeSessionId=s.id; return s;
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if(req.headers.host!==`127.0.0.1:${port}` && req.headers.host!==`localhost:${port}`) return json(res,{error:'Invalid host.'},403);
    const requestOrigin=req.headers.origin;
    if((requestOrigin && requestOrigin!==origin && requestOrigin!==`http://localhost:${port}`) || req.headers['sec-fetch-site']==='cross-site') return json(res,{error:'Cross-site access is blocked.'},403);
    const url=new URL(req.url,origin);
    if(url.pathname==='/api/health') return json(res,{app:'forge-local',ok:true});
    if(!url.pathname.startsWith('/api/')) {
      if(req.method!=='GET') return json(res,{error:'Method not allowed.'},405);
      const files={'/':'index.html','/app.js':'app.js','/chat-scroll.js':'chat-scroll.js','/layout.js':'layout.js','/layout.css':'layout.css','/project-command.js':'project-command.js','/voice-input.js':'voice-input.js','/live-transcription.js':'live-transcription.js','/microphone-meter.js':'microphone-meter.js','/voice-waveform.js':'voice-waveform.js','/style.css':'style.css','/icon.svg':'icon.svg'};
      const file=files[url.pathname]; if(!file) return json(res,{error:'Not found.'},404);
      res.setHeader('Set-Cookie',`forge_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/`);
      res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'image/svg+xml');
      return res.end(await fs.readFile(path.join(appDir,'public',file)));
    }
    const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('forge_session='))?.slice(14);
    if(cookie!==sessionCookie) return json(res,{error:'Open Forge in your browser to start a local session.'},401);
    if(req.method==='POST' && req.headers['x-forge-request']!=='1') return json(res,{error:'Invalid local request.'},403);
    if(req.method==='GET' && url.pathname==='/api/state') return json(res,{...state,commandMode:commandMode(activeSession()?.root),keyConfigured:!!apiKey,keySource,appDir,exampleProject:path.join(appDir,'projects','hello-windows'),run:run&&!run.finished?{id:run.id,sessionId:run.sessionId}:null});
    if(req.method==='GET' && url.pathname==='/api/events') {
      const task=runs.get(url.searchParams.get('id')); if(!task) return json(res,{error:'Task not found.'},404);
      res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'}); res.write(': connected\n\n');
      const after=Number(req.headers['last-event-id'] || 0);
      for(const event of task.events.filter(e=>e.id>after)) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      if(task.finished) return res.end();
      task.clients.add(res); const keep=setInterval(()=>res.write(': heartbeat\n\n'),15000);
      req.on('close',()=>{clearInterval(keep);task.clients.delete(res);}); return;
    }
    const session=activeSession();
    if(req.method==='GET' && url.pathname==='/api/files') { if(!session) throw new Error('Choose a project folder first.'); return json(res,await workspace(session).list(url.searchParams.get('path')||'.',3)); }
    if(req.method==='GET' && url.pathname==='/api/file') { if(!session) throw new Error('Choose a project folder first.'); return json(res,await workspace(session).read(url.searchParams.get('path'))); }
    if(req.method==='GET' && url.pathname==='/api/changes') return json(res,session?await workspace(session).changes():[]);
    if(req.method==='GET' && url.pathname==='/api/goal-presets') {
      try{return json(res,JSON.parse(await fs.readFile(path.join(dataDir,'goal-presets.json'),'utf8')));}catch(e){if(e.code==='ENOENT')return json(res,[]);throw e;}
    }
    if(req.method!=='POST') return json(res,{error:'Not found.'},404);
    if(url.pathname==='/api/transcribe') {
      if(!apiKey)throw new Error('Connect an OpenAI API key in Settings to use dictation.');
      if(transcribing)throw new Error('Another recording is being transcribed. Wait for it to finish.');
      transcribing=true;
      const controller=new AbortController();
      const cancel=()=>controller.abort();res.once('close',cancel);
      const timeout=setTimeout(cancel,90_000);
      try {
        const recording=await readAudio(req);
        const result=await transcribeAudio({...recording,key:apiKey,signal:controller.signal});
        return json(res,result);
      } catch(error) {
        if(controller.signal.aborted)throw new Error('Transcription was cancelled or timed out. Try a shorter recording.');
        throw error;
      } finally {clearTimeout(timeout);res.removeListener('close',cancel);transcribing=false;}
    }
    const data=await body(req);
    if(url.pathname==='/api/voice-session') {
      const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);
      const timeout=setTimeout(cancel,15_000);
      try{return json(res,await createTranscriptionCall({sdp:data.sdp,key:apiKey,signal:controller.signal}));}
      finally{clearTimeout(timeout);res.removeListener('close',cancel);}
    }
    if(url.pathname==='/api/goals') {
      requireIdle();if(!session)throw new Error('Choose the goal’s primary project first.');
      const goal=makeGoal(data,session.root);
      const allowed=Array.isArray(data.allowedRoots)&&data.allowedRoots.length?data.allowedRoots:[session.root];
      if(allowed.length>6)throw new Error('Use at most six project folders.');
      goal.allowedRoots=[...new Set(await Promise.all(allowed.map(folder=>projectRoot(folder))))];
      if(!goal.allowedRoots.some(folder=>sameProject(folder,session.root)))goal.allowedRoots.unshift(session.root);
      goal.readOnlyRoots=await Promise.all((data.readOnlyRoots||[]).map(folder=>projectRoot(folder)));
      if(goal.readOnlyRoots.some(folder=>!goal.allowedRoots.some(root=>sameProject(root,folder))))throw new Error('Read-only folders must also be in the allowed folder list.');
      state.goals.unshift(goal);session.goalId=goal.id;session.title=goal.title;await save();return json(res,{ok:true,goal});
    }
    if(url.pathname==='/api/goal-run') {
      requireIdle();if(!apiKey)throw new Error('Connect an OpenAI API key in Settings first.');
      const goal=state.goals.find(g=>g.id===data.id);if(!goal||!session||session.goalId!==goal.id)throw new Error('Select the chat containing this saved goal.');
      if(goal.status==='complete')throw new Error('This goal is complete. Create another goal for new work.');
      const task=createRun('goal',session);task.goal=goal;const ws=workspace(session,task);
      ws.readOnly=goal.readOnlyRoots.some(root=>sameProject(root,ws.root));
      const openProject=async requested=>{
        const root=await projectRoot(requested);
        if(!goal.allowedRoots.some(folder=>sameProject(folder,root)))throw new Error('That folder is outside this goal’s allowed project list.');
        const listing=await new Workspace(root,dataDir).list('.',1);
        ws.root=root;ws.readOnly=goal.readOnlyRoots.some(folder=>sameProject(folder,root));session.root=root;await save();emit(task,'project_changed',{root,mode:commandMode(root)});return {root,readOnly:!!ws.readOnly,...listing};
      };
      json(res,{id:task.id});
      void (async()=>{
        try {await pursueGoal({goal,run:task,session,config:{...state.config},runCycle:(config,send)=>runAgent({run:task,session,key:apiKey,config,workspace:ws,approve:(command,reason)=>commandApproval(task,ws,command,reason),openProject,checkpointGoal:async update=>{const result=recordCheckpoint(goal,update,session.messages);await save();emit(task,'goal',goal);return result;},emit:send,save}),emit:(type,value)=>emit(task,type,value),save});}
        catch(error){emit(task,'error',{text:error.message});emit(task,'done',{status:'failed'});}
        finally{finishRun(task);}
      })();
      return;
    }
    if(url.pathname==='/api/goal-pause') {
      const goal=state.goals.find(g=>g.id===data.id);if(!goal)throw new Error('Goal not found.');
      if(run&&!run.finished&&run.goal?.id===goal.id){goal.status='paused';run.controller.abort();}else if(goal.status!=='complete')goal.status='paused';
      await save();return json(res,{ok:true});
    }
    if(url.pathname==='/api/command-policy') {
      if(!session) throw new Error('Choose a project first.');
      if(!['ask','auto'].includes(data.mode)) throw new Error('Choose ask or auto for PowerShell approvals.');
      const root=await projectRoot(session.root);
      state.trustedProjects=state.trustedProjects.filter(folder=>!sameProject(folder,root));
      if(data.mode==='auto') state.trustedProjects.push(root);
      await save();
      const runningSession=run&&!run.finished ? state.sessions.find(s=>s.id===run.sessionId) : null;
      if(runningSession && sameProject(runningSession.root,root)) {
        emit(run,'command_policy',{mode:data.mode});
        // Changing the mode also releases a command already waiting for approval.
        if(data.mode==='auto' && run.approval) run.approval.resolve(true);
      }
      return json(res,{ok:true,mode:data.mode});
    }
    if(url.pathname==='/api/settings') {
      requireIdle();
      if(typeof data.model!=='string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(data.model)) throw new Error('Enter a valid OpenAI model ID.');
      if(!['low','medium','high'].includes(data.effort)) throw new Error('Choose a reasoning effort.');
      const maxRounds=Number(data.maxRounds),maxOutput=Number(data.maxOutput);
      if(!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>30||!Number.isInteger(maxOutput)||maxOutput<1024||maxOutput>32768) throw new Error('Use 1–30 API rounds and 1,024–32,768 output tokens.');
      if(data.apiKey) {
        const key=String(data.apiKey).trim(); if(!key.startsWith('sk-') || /\s/.test(key)) throw new Error('Enter an OpenAI API key beginning with sk-.');
        const encrypted=await dpapi(key); await fs.writeFile(path.join(dataDir,'key.dpapi'),encrypted); apiKey=key; keySource='Windows encrypted storage';
      }
      state.config={model:data.model,effort:data.effort,maxRounds,maxOutput}; await save(); return json(res,{ok:true,keyConfigured:!!apiKey});
    }
    if(url.pathname==='/api/check-key') {
      requireIdle(); if(!apiKey) throw new Error('Save an API key first.');
      const response=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(15000)});
      if(!response.ok) throw new Error(`OpenAI returned HTTP ${response.status}. Check key validity and permission to list models. This check does not confirm credit balance or Responses access.`);
      const data=await response.json(); return json(res,{ok:true,models:(data.data||[]).map(m=>m.id).filter(id=>/^gpt-/.test(id)&&!/(?:codex|audio|realtime|transcribe|tts|image)/i.test(id)).sort()});
    }
    if(url.pathname==='/api/browse') { requireIdle(); return json(res,await browseFolder()); }
    if(url.pathname==='/api/project') {
      requireIdle();
      const root=await projectRoot(data.path);
      const opened=newSession(root);
      if(typeof data.prompt==='string' && data.prompt.length<=24000) {
        opened.title='Open '+path.basename(root);
        opened.messages.push({role:'user',content:data.prompt,time:new Date().toISOString()},{role:'assistant',content:`Opened project: ${root}\n\nThis folder is now active. Project instructions and file contents have not been inspected yet.`,time:new Date().toISOString()});
      }
      await save(); return json(res,{ok:true,root,sessionId:opened.id});
    }
    if(url.pathname==='/api/new-chat') { requireIdle(); if(!session) throw new Error('Choose a project first.'); newSession(session.root); await save(); return json(res,{ok:true}); }
    if(url.pathname==='/api/session') { requireIdle(); if(!state.sessions.some(s=>s.id===data.id)) throw new Error('Chat not found.'); state.activeSessionId=data.id; await save(); return json(res,{ok:true}); }
    if(url.pathname==='/api/file') { requireIdle(); if(!session) throw new Error('Choose a project first.'); const result=await workspace(session).write(data.path,data.content,data.hash??null); return json(res,result); }
    if(url.pathname==='/api/undo') { requireIdle(); if(!session) throw new Error('Choose a project first.'); return json(res,await workspace(session).undo(data.id)); }
    if(url.pathname==='/api/approve') {
      if(!run || run.id!==data.runId || run.approval?.id!==data.id) throw new Error('That command is no longer awaiting approval.'); run.approval.resolve(data.approved===true); return json(res,{ok:true});
    }
    if(url.pathname==='/api/stop') { if(run&&!run.finished) run.controller.abort(); return json(res,{ok:true}); }
    if(url.pathname==='/api/run' || url.pathname==='/api/terminal') {
      requireIdle(); if(!session) throw new Error('Choose a project first.');
      const isAgent=url.pathname==='/api/run';
      if(isAgent && !apiKey) throw new Error('Connect an OpenAI API key in Settings first.');
      const text=String(isAgent?data.prompt:data.command).trim(); if(!text || text.length>24000) throw new Error('Enter a task or command shorter than 24,000 characters.');
      const task=createRun(isAgent?'agent':'terminal',session); const ws=workspace(session,task);
      if(isAgent) {
        session.messages.push({role:'user',content:text,time:new Date().toISOString()});
        if(session.title==='New task') session.title=text.slice(0,60); await save();
      }
      json(res,{id:task.id});
      const execute=async()=>{
        try {
          if(isAgent) await runAgent({run:task,session,key:apiKey,config:{...state.config},workspace:ws,approve:(command,reason)=>commandApproval(task,ws,command,reason),openProject:async requested=>{
            const root=await projectRoot(requested);
            const listing=await new Workspace(root,dataDir).list('.',1);
            ws.root=root;session.root=root;await save();
            emit(task,'project_changed',{root,mode:commandMode(root)});
            return {root,...listing,instructions:'This root and listing are verified. Read relevant project instructions before making changes. Earlier file references belong to the previous project.'};
          },emit:(type,value)=>emit(task,type,value),save});
          else { const result=await commandApproval(task,ws,text,'Run your PowerShell command'); emit(task,'tool_result',{name:'run_powershell',result}); emit(task,'done',{status:task.controller.signal.aborted?'stopped':result.denied?'declined':'complete'}); }
        } catch(e) { emit(task,'error',{text:task.controller.signal.aborted?'Stopped.':e.message}); emit(task,'done',{status:'failed'}); }
        finally { finishRun(task); }
      };
      void execute(); return;
    }
    return json(res,{error:'Not found.'},404);
  } catch(e) { if(!res.headersSent) json(res,{error:e.message || 'Request failed.'},400); else res.end(); }
});
server.requestTimeout=30000;
server.on('error',error=>{console.error(`Could not start Local API Dev Lab: ${error.code || error.message}.`);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`Local API Dev Lab is ready: ${origin}\nAPI key: ${apiKey?'configured':'connect in Settings'}\nPress Ctrl+C to stop.`));
for(const event of ['SIGINT','SIGTERM']) process.on(event,()=>{if(run&&!run.finished)run.controller.abort(); server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2500).unref();});
