import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {projectRoot} from './workspace.js';

export const rootKey=root=>path.resolve(root).replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
export function rememberProject(state,root,{name=path.basename(root),source='forge'}={}){
  state.projects=Array.isArray(state.projects)?state.projects:[];
  let project=state.projects.find(p=>rootKey(p.root)===rootKey(root));
  if(!project){project={id:crypto.createHash('sha256').update(rootKey(root)).digest('hex').slice(0,20),root,name,sources:[]};state.projects.push(project);}
  project.sources=Array.isArray(project.sources)?project.sources:[];
  if(!project.sources.includes(source))project.sources.push(source);
  if(source==='codex'&&name)project.name=name;
  return project;
}
export function migrateProjects(state){
  state.projects=Array.isArray(state.projects)?state.projects.filter(p=>typeof p.root==='string'&&path.isAbsolute(p.root)):[];
  for(const session of state.sessions||[])rememberProject(state,session.root);
  const active=state.sessions?.find(s=>s.id===state.activeSessionId);
  if(active)rememberProject(state,active.root).lastSessionId=active.id;
  state.schemaVersion=2;
}
export function projectSummaries(state){
  return (state.projects||[]).map(p=>{
    const chats=(state.sessions||[]).filter(s=>rootKey(s.root)===rootKey(p.root));
    const last=chats.find(s=>s.id===p.lastSessionId)||chats[0];
    return {...p,chatCount:chats.length,lastSessionId:last?.id||null,lastTitle:last?.title||'',lastOpened:p.lastOpened||last?.created||''};
  }).sort((a,b)=>b.lastOpened.localeCompare(a.lastOpened)||a.name.localeCompare(b.name));
}
export function selectSavedProject(state,project,newSession,{fresh=false}={}){
  const chats=state.sessions.filter(s=>rootKey(s.root)===rootKey(project.root));
  const session=(!fresh&&(chats.find(s=>s.id===project.lastSessionId)||chats[0]))||newSession(project.root);
  state.activeSessionId=session.id;project.lastSessionId=session.id;project.lastOpened=new Date().toISOString();return session;
}
export async function importCodexProjects(state,codexHome){
  try{
    const file=path.join(codexHome,'.codex-global-state.json'),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>5_000_000)throw new Error('Unsupported Codex project registry.');
    const data=JSON.parse(await fs.readFile(file,'utf8')),saved=data['local-projects'];
    const entries=Array.isArray(saved)?saved:Object.values(saved||{});let imported=0,unavailable=0;
    for(const entry of entries.slice(0,300))for(const candidate of (entry.rootPaths||[]).slice(0,8)){
      try{const root=await projectRoot(candidate);rememberProject(state,root,{name:entry.name||path.basename(root),source:'codex'});imported++;}catch{unavailable++;}
    }
    return {available:true,imported,unavailable,message:`${imported} local Codex folders found${unavailable?`; ${unavailable} unavailable`:''}.`};
  }catch(error){return {available:false,imported:0,message:error.code==='ENOENT'?'No local Codex project list found. Add an existing folder below.':'The Codex project list could not be read. Saved Forge projects are still available.'};}
}
export async function createProjectFolder(parent,name){
  if(typeof name!=='string'||!name.trim()||name.length>80||/[<>:"/\\|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)||/^\.{1,2}$/.test(name)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))throw new Error('Use a valid project name without slashes or reserved Windows names.');
  const base=await projectRoot(parent),root=path.join(base,name.trim());
  await fs.mkdir(root);return root;
}
export function resolveProjectRequest(requested,prompts,projects){
  if(typeof requested!=='string')return null;
  const matches=projects.filter(p=>rootKey(p.root)===rootKey(requested)||p.name.toLowerCase()===requested.toLowerCase());
  if(matches.length!==1)return null;
  const project=matches[0],duplicates=projects.filter(p=>p.name.toLowerCase()===project.name.toLowerCase());
  if(duplicates.length!==1)return null;
  const escaped=project.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const request=new RegExp('(?:^|\\b(?:open|select|use|switch(?:\\s+projects?)?\\s+to|work\\s+(?:in|on)|continue\\s+(?:in|on)|go\\s+to)\\s+)(?:(?:the|project|folder)\\s+)*["\x27`]?'+escaped+'(?=$|[^\\w-])','i');
  return prompts.some(text=>request.test(text.trim()))?project.root:null;
}
