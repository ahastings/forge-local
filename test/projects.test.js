import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {migrateProjects,rememberProject,projectSummaries,selectSavedProject,importCodexProjects,createProjectFolder,resolveProjectRequest} from '../lib/projects.js';
import {projectContext,environmentNames} from '../lib/project-context.js';
import {ChatDrafts} from '../public/chat-drafts.js';
import {runAgent} from '../lib/agent.js';
import {enableSharedProgress,recordSharedProgress,sharedProgressStatus,gitOverview} from '../lib/shared-progress.js';
import {Workspace} from '../lib/workspace.js';

async function fixture(){await fs.mkdir(path.join(process.cwd(),'.local-data'),{recursive:true});const base=await fs.mkdtemp(path.join(process.cwd(),'.local-data','project-test-'));const root=path.join(base,'alpha');await fs.mkdir(root);return {base,root};}
test('legacy chats, goals, usage and trust survive project migration unchanged',async()=>{
  const {root}=await fixture();const state={sessions:[{id:'one',root,title:'Calculator',messages:[{role:'user',content:'Keep this'}],usage:{calls:3}}],activeSessionId:'one',goals:[{id:'goal'}],trustedProjects:[root]};const before=structuredClone(state);
  migrateProjects(state);migrateProjects(state);assert.deepEqual(state.sessions,before.sessions);assert.deepEqual(state.goals,before.goals);assert.deepEqual(state.trustedProjects,before.trustedProjects);assert.equal(state.activeSessionId,'one');assert.equal(state.projects.length,1);assert.equal(projectSummaries(state)[0].chatCount,1);
});
test('switching projects resumes the last selected chat and fresh chats remain separate',async()=>{
  const {base,root}=await fixture(),other=path.join(base,'beta');await fs.mkdir(other);
  const state={sessions:[],projects:[]};let count=0;const create=root=>{const session={id:String(++count),root,messages:[]};state.sessions.unshift(session);return session;};
  const alpha=rememberProject(state,root),beta=rememberProject(state,other);const a1=selectSavedProject(state,alpha,create);const a2=selectSavedProject(state,alpha,create,{fresh:true});const b1=selectSavedProject(state,beta,create);
  assert.equal(selectSavedProject(state,alpha,create).id,a2.id);assert.equal(selectSavedProject(state,beta,create).id,b1.id);assert.equal(state.sessions.length,3);assert.notEqual(a1.id,a2.id);
});
test('Codex folder import deduplicates roots and never changes the source registry',async()=>{
  const {base,root}=await fixture(),codexHome=path.join(base,'codex');await fs.mkdir(codexHome);const registry=JSON.stringify({'local-projects':{one:{name:'Alpha app',rootPaths:[root]},two:{name:'Alpha app',rootPaths:[root]},missing:{name:'Gone',rootPaths:[path.join(base,'gone')]}}});const file=path.join(codexHome,'.codex-global-state.json');await fs.writeFile(file,registry);
  const state={sessions:[],projects:[]};const result=await importCodexProjects(state,codexHome);assert.equal(result.available,true);assert.equal(result.unavailable,1);assert.equal(state.projects.length,1);assert.equal(state.projects[0].name,'Alpha app');assert.equal(await fs.readFile(file,'utf8'),registry);
  await fs.writeFile(file,'invalid');assert.equal((await importCodexProjects(state,codexHome)).available,false);assert.equal(state.projects.length,1);
});
test('new projects create only a new child folder and reject traversal, collisions and reserved names',async()=>{
  const {base}=await fixture();const root=await createProjectFolder(base,'calculator');assert.deepEqual(await fs.readdir(root),[]);
  for(const name of ['../escape','a/b','a\\b','CON','NUL.txt','trailing.','..'])await assert.rejects(createProjectFolder(base,name));
  await assert.rejects(createProjectFolder(base,'calculator'),/EEXIST/);assert.ok((await fs.stat(root)).isDirectory());
});
test('saved names require an explicit user request and ambiguous names do not switch folders',async()=>{
  const {base,root}=await fixture();const projects=[{name:'Alpha',root}];
  assert.equal(resolveProjectRequest('Alpha',['Please open Alpha and inspect it.'],projects),root);
  assert.equal(resolveProjectRequest(root,['Continue in Alpha.'],projects),root);
  assert.equal(resolveProjectRequest('Alpha',['Compare Alpha with the other app.'],projects),null);
  assert.equal(resolveProjectRequest('Alpha',['Continue.'],projects),null);
  assert.equal(resolveProjectRequest('Alpha',['Open Alpha.'],[...projects,{name:'Alpha',root:path.join(base,'other')}]),null);
});
test('project context follows global and nested AGENTS overrides without leaking environment values',async()=>{
  const {base,root}=await fixture(),codexHome=path.join(base,'codex'),nested=path.join(root,'src');await fs.mkdir(codexHome);await fs.mkdir(nested);await fs.mkdir(path.join(root,'.git'));
  await fs.writeFile(path.join(codexHome,'AGENTS.md'),'Global defaults');await fs.writeFile(path.join(root,'AGENTS.md'),'Repository guidance');await fs.writeFile(path.join(nested,'AGENTS.md'),'Not this file');await fs.writeFile(path.join(nested,'AGENTS.override.md'),'Specific guidance');
  await fs.writeFile(path.join(nested,'README.md'),'Project overview');await fs.writeFile(path.join(nested,'.env'),'SERVICE_KEY=super-private-fixture\nEMPTY_KEY=""\nDISABLED_EXECUTION=false\n');
  const context=await projectContext(nested,{codexHome});assert.deepEqual(context.instructions.map(file=>file.text),['Global defaults','Repository guidance','Specific guidance']);assert.equal(context.documents[0].text,'Project overview');
  assert.deepEqual(context.environment[0].variables,[{name:'SERVICE_KEY',configured:true},{name:'EMPTY_KEY',configured:false},{name:'DISABLED_EXECUTION',configured:true}]);assert.doesNotMatch(JSON.stringify(context),/super-private-fixture/);assert.ok(!context.files.some(file=>file.path==='.env'));
});
test('environment inventory handles comments, empty quotes and multiline values without returning content',()=>{
  assert.deepEqual(environmentNames('export KEY_ONE=abc # comment\nEMPTY= # only comment\nQUOTED=""\nMULTI="first\nNOT_A_VARIABLE=private\nlast"\nFINAL=ready'),[{name:'KEY_ONE',configured:true},{name:'EMPTY',configured:false},{name:'QUOTED',configured:false},{name:'MULTI',configured:true},{name:'FINAL',configured:true}]);
});
test('linked project folders do not expose their files or environment inventory',async()=>{
  const {base,root}=await fixture(),outside=path.join(base,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'.env'),'OUTSIDE_KEY=private');await fs.symlink(outside,path.join(root,'reference'),process.platform==='win32'?'junction':'dir');
  const context=await projectContext(root);assert.equal(context.environment.length,0);assert.ok(!context.files.some(file=>file.path==='reference'));
});
test('chat drafts remain separate by chat and recover safely from invalid browser storage',()=>{
  let stored='invalid';const storage={getItem:()=>stored,setItem:(_key,value)=>{stored=value;}};const drafts=new ChatDrafts(storage);drafts.save('one','Calculator draft');drafts.save('two','Different project draft');assert.equal(new ChatDrafts(storage).get('one'),'Calculator draft');assert.equal(drafts.get('two'),'Different project draft');drafts.save('one','');assert.equal(drafts.get('one'),'');assert.equal(drafts.get('two'),'Different project draft');
});
test('agent rounds refresh project context after opening a saved project by its requested name',async()=>{
  const {base,root}=await fixture(),other=path.join(base,'beta');await fs.mkdir(other);const workspace={root};const session={root,messages:[{role:'user',content:'Open Beta and inspect the project overview.'}],usage:{calls:0,input:0,output:0}};let rounds=0;const observed=[];
  await runAgent({run:{controller:new AbortController()},session,key:'mock',workspace,config:{maxRounds:3},emit:()=>{},save:async()=>{},contextForRoot:async root=>({root,environment:[]}),resolveProject:(requested,prompts)=>resolveProjectRequest(requested,prompts,[{name:'Beta',root:other}]),openProject:async root=>{workspace.root=root;session.root=root;return {root};},callModel:async request=>{
    observed.push(request.projectContext.root);if(++rounds===1)return {status:'completed',output:[{type:'function_call',name:'open_project',call_id:'open',arguments:'{"path":"Beta"}'}]};
    if(rounds===2)return {status:'completed',output:[{type:'function_call',name:'project_context',call_id:'context',arguments:'{}'}]};
    assert.match(request.input.at(-1).output,/environment/);return {status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Loaded the selected project context.'}]}]};
  }});assert.deepEqual(observed,[root,other,other]);assert.equal(session.messages.at(-1).error,undefined);
});
test('shared progress preserves existing instructions and human notes and records only tool facts',async()=>{
  const {base,root}=await fixture(),dataDir=path.join(base,'data');await fs.writeFile(path.join(root,'AGENTS.md'),'Existing project rules.\n');
  await enableSharedProgress(root,dataDir);await enableSharedProgress(root,dataDir);const instructions=await fs.readFile(path.join(root,'AGENTS.md'),'utf8');assert.ok(instructions.startsWith('Existing project rules.'));assert.equal(instructions.split('forge-shared-context:start').length,2);assert.equal(await sharedProgressStatus(root),true);
  const workspace=new Workspace(root,dataDir),old=await workspace.read('FORGE-CONTEXT.md');await workspace.write('FORGE-CONTEXT.md',old.content.replace('Read the project files and record verified progress here when work is completed.','Current status written by Codex.'),old.hash);
  await recordSharedProgress(workspace,{messages:[{role:'user',content:'private chat text'},{role:'tool',name:'run_powershell',root,result:{exitCode:0,output:'private environment output'}},{role:'assistant',content:'private transcript'}]},'complete');
  const note=await fs.readFile(path.join(root,'FORGE-CONTEXT.md'),'utf8');assert.match(note,/Current status written by Codex/);assert.match(note,/run_powershell · exit 0/);assert.doesNotMatch(note,/private chat text|private environment output|private transcript/);assert.ok((await workspace.changes()).length>=3);
  assert.ok((await projectContext(root)).documents.some(file=>file.text.includes('Current status written by Codex.')));
});
test('shared progress honors override files and never writes to read-only reference workspaces',async()=>{
  const {base,root}=await fixture();await fs.writeFile(path.join(root,'AGENTS.override.md'),'Specific instructions.');await enableSharedProgress(root,path.join(base,'data'));assert.match(await fs.readFile(path.join(root,'AGENTS.override.md'),'utf8'),/FORGE-CONTEXT/);assert.equal(await fs.stat(path.join(root,'AGENTS.md')).catch(()=>null),null);
  const workspace=new Workspace(root,path.join(base,'data'));workspace.readOnly=true;const before=await fs.readFile(path.join(root,'FORGE-CONTEXT.md'),'utf8');assert.equal(await recordSharedProgress(workspace,{messages:[]},'complete'),false);assert.equal(await fs.readFile(path.join(root,'FORGE-CONTEXT.md'),'utf8'),before);
});
test('non-Git project previews degrade safely without changing project files',async()=>{
  const {root}=await fixture();const before=await fs.readdir(root);assert.deepEqual(await gitOverview(root),{available:false,changes:[]});assert.deepEqual(await fs.readdir(root),before);
});
