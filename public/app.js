import { projectCommand } from './project-command.js';
import { VoiceInput, DictationDraft } from './voice-input.js';
import { LiveTranscription } from './live-transcription.js';
import { microphoneMeter } from './microphone-meter.js';
import { VoiceWaveform } from './voice-waveform.js';
import { ChatScroll } from './chat-scroll.js';
import { PanelLayout } from './layout.js';
const $ = id => document.getElementById(id);
let state, activeRun = null, events = null, approval = null, streamBubble = null, file = null, dirty = false, changes = [], toastTimer;
let goalPresets=[];
const number = n => new Intl.NumberFormat().format(n || 0);
const basename = p => p?.split(/[\\/]/).filter(Boolean).at(-1) || 'Choose project';
async function api(route, data) {
  if(data!==undefined&&['project','session','new-chat'].includes(route))voice.cancel();
  const res = await fetch('/api/'+route,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Request':'1'},body:JSON.stringify(data)});
  const result = await res.json(); if(!res.ok) throw new Error(result.error || 'Request failed.'); return result;
}
function toast(text,error=false) {
  $('toast').textContent=text; $('toast').className='toast'+(error?' error':''); clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),6500);
}
const action = fn => async event => { try { await fn(event); } catch(e) {toast(e.message,true);} };
const panels=new PanelLayout();
const chatScroll=new ChatScroll($('messages'),$('jumpToLatest'));
const speechDraft=new DictationDraft(),waveform=new VoiceWaveform($('voiceWaveform'));
let voiceNotice='';
function applySpeech(result){if(!result)return;$('prompt').value=result.value;$('prompt').setSelectionRange(result.caret,result.caret);$('prompt').scrollTop=$('prompt').scrollHeight;}
function voiceStatus(text){$('voiceStatus').textContent=text;$('composerHint').textContent=text;$('composerHint').title=voiceNotice||text;}
const voice = new VoiceInput({
  createLive:options=>new LiveTranscription(options),monitor:microphoneMeter,
  onPreview:text=>applySpeech(speechDraft.preview(text)),
  onLevel:level=>{waveform.push(level);$('voiceWaveform').title=level>.06?'Voice detected':'Listening for speech';},
  onLiveStatus:text=>{voiceNotice=text;$('composerHint').title=text;if(/unavailable/i.test(text))voiceStatus('Live text unavailable · Text after stopping');},
  transcribe:async(audio,signal)=>{
    const response=await fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':audio.type,'X-Forge-Request':'1'},body:audio,signal});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Transcription failed. Try again.');return result;
  },
  onText:text=>{
    applySpeech(speechDraft.finish(text));$('prompt').focus();voiceStatus('Text ready · Review it, then send');
  },
  onState:({phase,seconds=0,cancelled})=>{
    const recording=phase==='recording',idle=phase==='idle';
    if(phase==='requesting'){speechDraft.begin($('prompt').value,$('prompt').selectionStart,$('prompt').selectionEnd);waveform.reset();voiceNotice='';}
    if(cancelled)applySpeech(speechDraft.cancel());
    $('prompt').readOnly=!idle;
    $('voiceButton').classList.toggle('recording',recording);$('composer').classList.toggle('dictating',!idle);
    $('voiceButton').setAttribute('aria-pressed',String(recording));$('voiceButton').setAttribute('aria-label',recording?'Stop dictation':phase==='transcribing'?'Transcribing audio':phase==='stopping'?'Finishing recording':'Start dictation');
    $('voiceButton').title=recording?'Stop recording and transcribe':'Dictate with your default microphone';
    $('voiceButton').disabled=!idle&&!recording;$('sendButton').disabled=!idle;
    $('voiceCancel').classList.toggle('hidden',!recording&&phase!=='requesting');
    $('voiceWaveform').classList.toggle('hidden',!recording&&phase!=='connecting');
    $('composerMeta').classList.toggle('voice-active',!idle);
    if(phase==='connecting')$('voiceCancel').classList.remove('hidden');
    if(phase==='transcribing')$('voiceCancel').classList.remove('hidden');
    $('voiceCancel').title=phase==='transcribing'?'Stop waiting':'Cancel dictation';
    voiceStatus(recording?`${/unavailable/i.test(voiceNotice)?'Text after stopping':'Listening'} ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} · Click mic to finish`:phase==='requesting'?'Allow microphone access…':phase==='connecting'?'Connecting live text…':phase==='stopping'?'Finishing audio…':phase==='transcribing'?'Finishing your transcript…':cancelled?'Dictation cancelled · Draft kept':'Enter to send · Shift Enter for a new line');
  },
  onError:text=>{applySpeech(speechDraft.cancel());$('prompt').readOnly=false;voiceStatus(text);toast(text,true);}
});
$('voiceButton').addEventListener('click',()=>{
  if(voice.phase==='recording')return voice.stop();
  if(!state)return toast('Wait for the app to connect.',true);
  if(!state.keyConfigured)return showSettings();
  void voice.start();
});
$('voiceCancel').onclick=()=>voice.cancel();
if(!voice.supported)voiceStatus('Mic unavailable here · Open this app in Chrome or Edge');
function setBusy(value,text) {
  $('runStatus').textContent=text || (value?'Working on your task':'Ready when you are'); $('runDot').classList.toggle('busy',value);
  $('stopButton').classList.toggle('hidden',!value); $('sendButton').classList.toggle('hidden',value);
  for(const id of ['chooseProject','newChat','composerProject','saveFile','newFile','activeProjectPath']) $(id).disabled=value || (id==='saveFile'&&!file);
}
function usage(value) { $('usageText').textContent=`${number(value?.calls)} API calls · ${number((value?.input||0)+(value?.output||0))} tokens`; }
function selectedGoal(){const session=state?.sessions.find(s=>s.id===state.activeSessionId);return state?.goals?.find(g=>g.id===session?.goalId);}
function renderGoal(goal=selectedGoal()) {
  $('goalPanel').classList.toggle('hidden',!goal);if(!goal)return;
  $('goalTitle').textContent=goal.title;$('goalTitle').title=goal.title;$('goalDetailsTitle').textContent=goal.title;$('goalStatus').textContent=goal.status.replaceAll('_',' ');$('goalSummary').textContent=goal.summary;
  $('goalRun').disabled=!!activeRun||goal.status==='complete';$('goalRun').textContent=goal.totalCalls?'Resume goal':'Run goal';$('goalPause').classList.toggle('hidden',goal.status!=='running');
  $('goalNextStep').textContent='Next: '+goal.nextStep;$('goalBudget').textContent=`Up to ${goal.maxCycles} cycles / ${goal.maxCalls} API calls per run · ${goal.totalCalls} calls used by this goal`;
  $('goalCriteria').replaceChildren();for(const c of goal.criteria){const li=document.createElement('li');li.textContent=(c.status==='done'?'✓ ':c.status==='blocked'?'! ':'○ ')+c.text;$('goalCriteria').append(li);}
}
function fillGoalForm(goal) {
  $('goalName').value=goal.title||'';$('goalObjective').value=goal.objective||'';$('goalChecks').value=(goal.criteria||[]).map(c=>typeof c==='string'?c:c.text).join('\n');$('goalConstraints').value=goal.constraints||'';
  $('goalAllowedRoots').value=(goal.allowedRoots||[]).join('\n');$('goalReadOnlyRoots').value=(goal.readOnlyRoots||[]).join('\n');$('goalCycles').value=goal.maxCycles||3;$('goalCalls').value=goal.maxCalls||24;
}
async function showGoals() {
  if(!state.activeSessionId)return showProject();
  goalPresets=await api('goal-presets');$('loadStockGoal').classList.toggle('hidden',!goalPresets.length);
  fillGoalForm({allowedRoots:[state.sessions.find(s=>s.id===state.activeSessionId).root],criteria:[],maxCycles:3,maxCalls:24});$('goalDialog').showModal();
}
function renderCommandMode(mode) {
  state.commandMode=mode;
  $('commandPolicy').value=mode;
  $('commandPolicy').disabled=!state.activeSessionId;
  $('terminalRunButton').textContent=mode==='auto'?'Run ↗':'Review & run ↗';
}
async function setCommandMode(mode) {
  const previous=state.commandMode||'ask';
  try {
    const result=await api('command-policy',{mode});renderCommandMode(result.mode);
    toast(result.mode==='auto'?'PowerShell runs automatically for this project. Commands use your Windows account permissions.':'PowerShell will ask before each command.');
  } catch(error) { renderCommandMode(previous);throw error; }
}
function inline(parent,text) {
  const parts=text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for(const part of parts) {
    if(part.startsWith('`')&&part.endsWith('`')) {const c=document.createElement('code');c.textContent=part.slice(1,-1);parent.append(c);}
    else if(part.startsWith('**')&&part.endsWith('**')) {const b=document.createElement('strong');b.textContent=part.slice(2,-2);parent.append(b);}
    else parent.append(document.createTextNode(part));
  }
}
function markdown(parent,text) {
  parent.replaceChildren();const pieces=text.split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
  pieces.forEach((part,i)=>{
    if(i%2) {const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=part.replace(/\n$/,'');pre.append(code);parent.append(pre);}
    else for(const paragraph of part.split(/\n\n+/).filter(Boolean)) {const p=document.createElement('p');inline(p,paragraph.replace(/^#{1,6} /gm,''));parent.append(p);}
  });
}
function message(role,text) {
  const row=document.createElement('article');row.className='message '+role;
  const heading=document.createElement('div');heading.className='message-heading';
  const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=role==='user'?'Y':'f';
  heading.append(avatar,document.createTextNode(role==='user'?'YOU':'DEV LAB'));
  const body=document.createElement('div');body.className='message-body';
  if(role==='assistant')markdown(body,text);else body.textContent=text;
  row.append(heading,body);chatScroll.update(()=>$('messages').append(row));return {row,body,text};
}
function toolResult(row,result,root,command) {
  if(!result)return;
  const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
  details.className='tool-details';summary.textContent=result.exitCode!==undefined?'View result · PowerShell exit '+result.exitCode:'View tool result';
  pre.textContent=(root?'Project: '+root+'\n':'')+(command?'PS > '+command+'\n\n':'')+(typeof result.output==='string'?result.output:JSON.stringify(result,null,2));
  details.append(summary,pre);chatScroll.update(()=>row.append(details));
}
function toolLine(text,error=false,result=null,root='',command='') {const el=document.createElement('div');el.className='tool-row'+(error?' error':'');el.textContent=text;toolResult(el,result,root,command);chatScroll.update(()=>$('messages').append(el));return el;}
function renderMessages(session,{reset=false}={}) {
  const render=()=>{
  if(!session?.messages.length) { $('welcome').classList.remove('hidden'); for(const row of [...$('messages').children]) if(row.id!=='welcome')row.remove();return; }
  $('welcome').classList.add('hidden');for(const row of [...$('messages').children])if(row.id!=='welcome')row.remove();
  for(const m of session.messages) {if(m.role==='tool'){const row=toolLine(m.content,!!m.error,m.result,m.root,m.command);if(m.id)row.dataset.toolId=m.id;}else message(m.role,m.content);}
  };
  if(reset)chatScroll.reset(render);else chatScroll.update(render);
}
async function loadState({render=true}={}) {
  const previousSession=state?.activeSessionId;
  state=await api('state');if(previousSession&&previousSession!==state.activeSessionId)voice.cancel();
  const session=state.sessions.find(s=>s.id===state.activeSessionId);
  renderCommandMode(state.commandMode||'ask');
  $('projectName').textContent=session?basename(session.root):'Choose a project';$('projectHint').textContent=session?'Local Windows folder':'A folder on your computer';
  $('composerFolderName').textContent=session?basename(session.root):'Choose project';$('rootPath').textContent=session?.root||'No project selected';$('rootPath').title=session?.root||'';
  if(document.activeElement!==$('activeProjectPath')) $('activeProjectPath').value=session?.root||'';
  $('taskTitle').textContent=session?.title||'New task'; $('modelLabel').textContent=state.config.model.replace(/^gpt-/,'GPT-').replace(/-sol$/,' Sol').replace(/-terra$/,' Terra');
  $('connectionBanner').classList.toggle('hidden',state.keyConfigured); usage(session?.usage);
  $('sessions').replaceChildren();
  if(!state.sessions.length){const p=document.createElement('p');p.className='muted small';p.textContent='Your work starts here.';$('sessions').append(p);}
  for(const s of state.sessions) {
    const b=document.createElement('button');b.className='session-item'+(s.id===session?.id?' active':'');b.textContent='◦  '+s.title;b.title=s.root;
    b.addEventListener('click',action(async()=>{if(!canDiscard())return;await api('session',{id:s.id});clearEditor();await loadState();await refreshFiles();await refreshChanges();}));$('sessions').append(b);
  }
  if(render)renderMessages(session,{reset:previousSession!==state.activeSessionId});
  renderGoal();
  if(state.run&&!activeRun) connectRun(state.run.id);
  else if(!activeRun)setBusy(false);
}
function canDiscard() {return !dirty || confirm('You have unsaved file edits. Discard them?');}
function clearEditor(){file=null;dirty=false;$('editorWrap').classList.add('hidden');$('editorEmpty').classList.remove('hidden');$('editorPath').textContent='No file selected';$('saveFile').disabled=true;}
async function refreshFiles() {
  if(!state.activeSessionId)return;
  const result=await api('files');$('files').replaceChildren();
  if(!result.entries.length){const p=document.createElement('p');p.className='muted small';p.textContent='An open canvas. Add a file or give Forge a task.';$('files').append(p);}
  for(const entry of result.entries) {
    const b=document.createElement('button');b.className='tree-item'+(entry.type==='folder'?' folder':'')+(entry.path===file?.path?' active':'');b.title=entry.path;
    b.style.paddingLeft=(7+Math.min(4,entry.path.split('/').length-1)*10)+'px';
    const icon=document.createElement('span');icon.className='tree-symbol';icon.textContent=entry.type==='folder'?'▱':'·';b.append(icon,document.createTextNode(basename(entry.path)));
    if(entry.type==='file')b.addEventListener('click',action(()=>openFile(entry.path)));else b.disabled=true;
    $('files').append(b);
  }
  if(result.clipped){const p=document.createElement('p');p.className='muted small';p.textContent='Showing up to 500 entries. The agent can list subfolders directly.';$('files').append(p);}
}
function lineNumbers() {$('lineNumbers').textContent=Array.from({length:$('fileContent').value.split('\n').length},(_,i)=>i+1).join('\n');}
async function openFile(relative,{force=false}={}) {
  if(!force&&!canDiscard())return;
  file=await api('file?path='+encodeURIComponent(relative));dirty=false;
  $('editorPath').textContent=file.path;$('fileContent').value=file.content;$('editorWrap').classList.remove('hidden');$('editorEmpty').classList.add('hidden');$('saveFile').disabled=!!activeRun;$('saveFile').textContent='Save';lineNumbers();showInspector('file');
  $('editorStatus').textContent='UTF-8 · Saved on your computer';await refreshFiles();
}
function showInspector(tab) {
  panels.openEditor();
  $('fileTab').classList.toggle('active',tab==='file');$('changesTab').classList.toggle('active',tab==='changes');$('editorPanel').classList.toggle('hidden',tab!=='file');$('changesPanel').classList.toggle('hidden',tab!=='changes');
}
async function refreshChanges() {
  changes=await api('changes');const pending=changes.filter(c=>!c.undone).reverse();$('changeCount').textContent=pending.length;$('changesList').replaceChildren();
  if(!pending.length){const p=document.createElement('p');p.className='muted small';p.textContent='No file edits yet. Agent and editor saves will appear here.';$('changesList').append(p);}
  for(const c of pending.slice(0,60)) {
    const card=document.createElement('div');card.className='change-card';const name=document.createElement('div');name.className='change-name';name.textContent=c.path;
    const meta=document.createElement('div');meta.className='change-meta';meta.textContent=(c.before===null?'Created':'Updated')+' · '+new Date(c.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const buttons=document.createElement('div');buttons.className='change-actions';const view=document.createElement('button');view.textContent='View change';view.onclick=()=>viewDiff(c);
    const undo=document.createElement('button');undo.textContent='Undo';undo.disabled=!!activeRun;undo.addEventListener('click',action(async()=>{
      if(!canDiscard())return;
      await api('undo',{id:c.id});await refreshChanges();await refreshFiles();if(file?.path===c.path){if(c.before===null)clearEditor();else await openFile(c.path,{force:true});}toast('File change undone.');
    }));buttons.append(view,undo);card.append(name,meta,buttons);$('changesList').append(card);
  }
}
function viewDiff(c) {
  $('diffTitle').textContent=c.path;$('diffContent').replaceChildren();
  const a=(c.before||'').split('\n'),b=c.after.split('\n');let start=0,end=0;
  while(start<Math.min(a.length,b.length)&&a[start]===b[start])start++;
  while(end<Math.min(a.length,b.length)-start&&a[a.length-1-end]===b[b.length-1-end])end++;
  const rows=[...a.slice(Math.max(0,start-3),start).map(s=>[' ',s]),...a.slice(start,a.length-end).map(s=>['-',s]),...b.slice(start,b.length-end).map(s=>['+',s]),...b.slice(b.length-end,b.length-end+3).map(s=>[' ',s])];
  for(const [kind,text] of rows.slice(0,800)){const line=document.createElement('div');line.className=kind==='+'?'diff-added':kind==='-'?'diff-removed':'';line.textContent=kind+' '+text;$('diffContent').append(line);}
  if(rows.length>800)$('diffContent').append(document.createTextNode('\nPreview limited to 800 lines. Full snapshots are saved locally.'));
  $('diffDialog').showModal();
}
function showProject(){if(activeRun)return toast('Stop the active task before switching projects.',true);$('projectPath').value=state.sessions.find(s=>s.id===state.activeSessionId)?.root||'';$('projectDialog').showModal();}
function showSettings() {
  $('apiKey').value='';$('model').value=state.config.model;$('effort').value=state.config.effort;$('maxRounds').value=state.config.maxRounds;$('maxOutput').value=state.config.maxOutput;
  $('keyStatus').textContent=state.keyConfigured?'● Key connected · '+state.keySource:'○ No API key connected';$('connectionResult').textContent='';$('settingsDialog').showModal();
}
function terminal(text) {const el=$('terminalOutput');el.textContent=(el.textContent+'\n'+text).slice(-70000);el.scrollTop=el.scrollHeight;}
function connectRun(id) {
  activeRun=id;setBusy(true);streamBubble=null;
  if(events)events.close();events=new EventSource('/api/events?id='+encodeURIComponent(id));
  const on=(type,fn)=>events.addEventListener(type,event=>{try{fn(JSON.parse(event.data));}catch(e){toast(e.message,true);}});
  on('status',data=>setBusy(true,data.text));
  on('delta',data=>chatScroll.update(()=>{if(!streamBubble)streamBubble=message('assistant','');streamBubble.text+=data.text;streamBubble.body.textContent=streamBubble.text;}));
  on('message',data=>chatScroll.update(()=>{if(streamBubble){streamBubble.text=data.text;markdown(streamBubble.body,data.text);}else message('assistant',data.text);streamBubble=null;}));
  on('tool',data=>{const details=data.args?.path||data.args?.query||data.args?.reason||'';const row=toolLine('› '+data.name.replaceAll('_',' ')+'  '+details);row.dataset.toolId=data.id;row.dataset.command=data.args?.command||'';});
  on('tool_result',data=>{const row=[...document.querySelectorAll('[data-tool-id]')].find(el=>el.dataset.toolId===data.id);if(row)toolResult(row,data.result,$('activeProjectPath').value,row.dataset.command);if(data.result?.error)toolLine(data.result.error,true);if(data.name==='run_powershell'&&data.result?.denied)terminal('Command declined.');});
  on('approval',data=>{approval=data;$('approvalReason').textContent=data.reason;$('approvalCommand').textContent=data.command;$('approvalCwd').textContent=data.cwd;$('approval').classList.remove('hidden');terminal('\nPS > '+data.command);setBusy(true,'Waiting for your command approval');});
  on('approval_resolved',data=>{approval=null;$('approval').classList.add('hidden');if(!data.approved)terminal('Command was not approved.');});
  on('command_auto',data=>terminal('\nPS [automatic] > '+data.command));
  on('command_policy',data=>renderCommandMode(data.mode));
  on('project_changed',data=>{
    voice.cancel();
    $('projectName').textContent=basename(data.root);$('composerFolderName').textContent=basename(data.root);$('rootPath').textContent=data.root;$('activeProjectPath').value=data.root;
    renderCommandMode(data.mode);clearEditor();toolLine('Project opened: '+data.root);refreshFiles().catch(()=>{});refreshChanges().catch(()=>{});
  });
  on('terminal',data=>{const out=$('terminalOutput');out.textContent=(out.textContent+data.text).slice(-70000);out.scrollTop=out.scrollHeight;});
  on('command_done',data=>terminal(`[exit ${data.exitCode ?? 'stopped'}${data.timedOut?' · timeout':''}]`));
  on('usage',usage);
  on('goal',goal=>{const index=state.goals?.findIndex(g=>g.id===goal.id)??-1;if(index>=0)state.goals[index]=goal;else(state.goals||=[]).push(goal);renderGoal(goal);});
  on('change',()=>{refreshFiles().catch(()=>{});refreshChanges().catch(()=>{});});
  on('error',data=>{if(data?.text){toolLine(data.text,true);toast(data.text,true);}});
  on('done',async data=>{
    events.close();events=null;activeRun=null;approval=null;streamBubble=null;$('approval').classList.add('hidden');setBusy(false,data.status==='complete'?'Task complete':data.status==='stopped'?'Stopped':'Task ended');
    try {await loadState();await refreshFiles();await refreshChanges();if(file&&!dirty)try{await openFile(file.path,{force:true});}catch{} }catch(e){toast(e.message,true);}
    $('runStatus').textContent=data.status==='complete'?'Task complete':data.status==='stopped'?'Stopped':'Task ended';
  });
  events.onerror=()=>{if(activeRun)$('runStatus').textContent='Reconnecting to the local agent…';};
}
async function submitPrompt() {
  if(voice.active)return toast('Finish dictation or cancel it before sending.');
  if(activeRun)return;
  const prompt=$('prompt').value.trim();if(!prompt)return;
  const requestedProject=projectCommand(prompt);
  if(requestedProject) {
    if(!canDiscard())return;
    await api('project',{path:requestedProject,prompt});$('prompt').value='';clearEditor();await loadState();await refreshFiles();await refreshChanges();terminal('Project opened: '+requestedProject);return;
  }
  if(!state.activeSessionId)return showProject();if(!state.keyConfigured)return showSettings();
  const result=await api('run',{prompt});$('welcome').classList.add('hidden');message('user',prompt);$('prompt').value='';connectRun(result.id);
}
$('chooseProject').onclick=showProject;$('composerProject').onclick=showProject;
$('settingsButton').onclick=showSettings;$('connectButton').onclick=showSettings;
$('goalButton').addEventListener('click',action(showGoals));
$('goalDetailsButton').onclick=()=>$('goalDetailsDialog').showModal();
$('loadStockGoal').onclick=()=>{if(goalPresets[0])fillGoalForm(goalPresets[0]);};
$('goalForm').addEventListener('submit',action(async event=>{
  event.preventDefault();const lines=id=>$(id).value.split('\n').map(s=>s.trim()).filter(Boolean);
  await api('goals',{title:$('goalName').value,objective:$('goalObjective').value,criteria:lines('goalChecks'),constraints:$('goalConstraints').value,allowedRoots:lines('goalAllowedRoots'),readOnlyRoots:lines('goalReadOnlyRoots'),maxCycles:Number($('goalCycles').value),maxCalls:Number($('goalCalls').value)});
  $('goalDialog').close();await loadState({render:false});toast('Goal saved. Run it when you are ready to use API credits.');
}));
$('goalRun').addEventListener('click',action(async()=>{const goal=selectedGoal();if(!goal)return;const result=await api('goal-run',{id:goal.id});connectRun(result.id);renderGoal();}));
$('goalPause').addEventListener('click',action(async()=>{const goal=selectedGoal();if(goal)await api('goal-pause',{id:goal.id});}));
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
for(const b of document.querySelectorAll('[data-prompt]'))b.onclick=()=>{voice.cancel();$('prompt').value=b.dataset.prompt;$('prompt').focus();if(!state.activeSessionId)showProject();};
$('projectForm').addEventListener('submit',action(async e=>{e.preventDefault();if(!canDiscard())return;await api('project',{path:$('projectPath').value.trim()});$('projectDialog').close();clearEditor();await loadState();await refreshFiles();await refreshChanges();terminal('Project: '+$('projectPath').value.trim());}));
$('projectPathForm').addEventListener('submit',action(async e=>{e.preventDefault();if(activeRun)return toast('Wait for the active task or stop it before switching folders.',true);if(!canDiscard())return;await api('project',{path:$('activeProjectPath').value.trim()});clearEditor();await loadState();await refreshFiles();await refreshChanges();toast('Project folder opened.');}));
$('browseButton').addEventListener('click',action(async()=>{const b=$('browseButton');b.disabled=true;b.textContent='Choosing…';try{const data=await api('browse',{});if(data.path)$('projectPath').value=data.path;}finally{b.disabled=false;b.textContent='Browse…';}}));
$('exampleButton').onclick=()=>{$('projectPath').value=state.exampleProject;$('projectForm').requestSubmit();};
$('newChat').addEventListener('click',action(async()=>{if(!state.activeSessionId)return showProject();await api('new-chat',{});await loadState();$('prompt').focus();}));
$('settingsForm').addEventListener('submit',action(async e=>{
  e.preventDefault();await api('settings',{apiKey:$('apiKey').value,model:$('model').value.trim(),effort:$('effort').value,maxRounds:Number($('maxRounds').value),maxOutput:Number($('maxOutput').value)});
  $('apiKey').value='';await loadState({render:false});$('keyStatus').textContent=state.keyConfigured?'● Key connected · '+state.keySource:'○ No API key connected';toast('Settings saved.');$('settingsDialog').close();
}));
$('checkKey').addEventListener('click',action(async()=>{
  $('connectionResult').textContent='Checking saved key…';
  try {const result=await api('check-key',{});$('connectionResult').textContent='Key accepted. '+result.models.length+' GPT model IDs visible. This check does not verify credit balance or Responses access.';
    for(const model of result.models){const option=document.createElement('option');option.value=model;$('modelOptions').append(option);}
  }catch(e){$('connectionResult').textContent=e.message;throw e;}
}));
$('composer').addEventListener('submit',action(async e=>{e.preventDefault();await submitPrompt();}));
$('prompt').addEventListener('keydown',action(async e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();await submitPrompt();}}));
$('stopButton').addEventListener('click',action(async()=>{await api('stop',{});$('runStatus').textContent='Stopping…';}));
async function decide(approved){if(!approval)return;await api('approve',{runId:activeRun,id:approval.id,approved});}
$('approveCommand').addEventListener('click',action(()=>decide(true)));$('declineCommand').addEventListener('click',action(()=>decide(false)));
$('commandPolicy').addEventListener('change',action(event=>setCommandMode(event.target.value)));
$('autoApproveProject').addEventListener('click',action(()=>setCommandMode('auto')));
$('refreshFiles').addEventListener('click',action(refreshFiles));
$('fileTab').onclick=()=>showInspector('file');$('changesTab').addEventListener('click',action(async()=>{showInspector('changes');await refreshChanges();}));
$('fileContent').addEventListener('input',()=>{dirty=true;$('saveFile').textContent='Save •';$('editorStatus').textContent='Unsaved changes';lineNumbers();});
$('fileContent').addEventListener('scroll',()=>{$('lineNumbers').scrollTop=$('fileContent').scrollTop;});
$('fileContent').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const t=e.target,start=t.selectionStart,end=t.selectionEnd;t.setRangeText('  ',start,end,'end');t.dispatchEvent(new Event('input'));}});
$('saveFile').addEventListener('click',action(async()=>{if(!file)return;const result=await api('file',{path:file.path,content:$('fileContent').value,hash:file.hash});file.hash=result.hash||file.hash;file.content=$('fileContent').value;dirty=false;$('saveFile').textContent='Save';$('editorStatus').textContent='UTF-8 · Saved on your computer';await refreshFiles();await refreshChanges();toast('File saved with a recoverable snapshot.');}));
$('newFile').onclick=()=>{if(!state.activeSessionId)return showProject();$('newFilePath').value='';$('newFileDialog').showModal();};
$('newFileForm').addEventListener('submit',action(async e=>{e.preventDefault();if(!canDiscard())return;const relative=$('newFilePath').value.trim();try{file=await api('file?path='+encodeURIComponent(relative));}catch(error){if(!/ENOENT/.test(error.message))throw error;file={path:relative,content:'',hash:null};}
  dirty=false;$('editorPath').textContent=file.path;$('fileContent').value=file.content;$('editorEmpty').classList.add('hidden');$('editorWrap').classList.remove('hidden');$('saveFile').disabled=false;lineNumbers();showInspector('file');$('newFileDialog').close();$('fileContent').focus();
}));
$('terminalForm').addEventListener('submit',action(async e=>{e.preventDefault();if(activeRun)return toast('Wait for the active task or stop it first.',true);if(!state.activeSessionId)return showProject();const command=$('terminalCommand').value.trim();if(!command)return;const result=await api('terminal',{command});$('terminalCommand').value='';connectRun(result.id);}));
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('newChat').click();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(file)$('saveFile').click();}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&voice.active){e.preventDefault();voice.cancel();}});
window.addEventListener('pagehide',()=>voice.cancel());
window.addEventListener('beforeunload',e=>{voice.cancel();if(dirty){e.preventDefault();e.returnValue='';}});
loadState().then(()=>Promise.all([refreshFiles(),refreshChanges()])).catch(e=>toast('Could not connect to API Dev Lab: '+e.message,true));
