import fs from 'node:fs/promises';
import path from 'node:path';
import {Workspace} from './workspace.js';

export function safeText(text){
  return text.replace(/\b(?:sk-(?:proj-|svcacct-)?[\w-]{24,}|gh[pousr]_[\w]{24,}|github_pat_[\w]{30,})\b/g,'[REDACTED]')
    .replace(/^(\s*(?:export\s+)?[\w]*(?:KEY|TOKEN|SECRET|PASSWORD)[\w]*\s*[:=]\s*).+$/gim,'$1[REDACTED]');
}
async function textFile(file,limit=32_768){
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>300_000)return null;const bytes=await fs.readFile(file);if(bytes.includes(0))return null;return {path:file,text:safeText(bytes.subarray(0,limit).toString('utf8').replace(/\uFFFD$/,'')),truncated:bytes.length>limit};}
  catch(error){if(error.code==='ENOENT')return null;return {path:file,text:'',error:'File could not be read.'};}
}
export function environmentNames(text){
  const variables=[];let quote=null;
  for(const line of text.split(/\r?\n/)){
    if(quote){if(line.trimEnd().endsWith(quote))quote=null;continue;}
    const match=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);if(!match)continue;
    let value=match[2].trim();
    if(value.startsWith('"')||value.startsWith("'")){const marker=value[0];if(value.length>1&&value.endsWith(marker))value=value.slice(1,-1);else{quote=marker;value=value.slice(1);}}
    else value=value.replace(/\s*#.*$/,'').trim();
    variables.push({name:match[1],configured:value.length>0});
  }
  return variables;
}
export async function projectContext(root,{codexHome,dataDir,includeEnvironment=true}={}){
  const instructions=[],documents=[],environment=[];let budget=32_768;
  const addGuidance=async directory=>{
    for(const name of ['AGENTS.override.md','AGENTS.md']){const file=await textFile(path.join(directory,name),Math.max(0,budget));if(file?.text.trim()){instructions.push(file);budget-=Buffer.byteLength(file.text);break;}}
  };
  if(codexHome)await addGuidance(codexHome);
  const directories=[root];let current=root;
  for(let depth=0;depth<20;depth++){
    try{await fs.lstat(path.join(current,'.git'));break;}catch{}
    const parent=path.dirname(current);if(parent===current)break;
    directories.unshift(parent);current=parent;
  }
  // Without a repository boundary, only the selected folder provides project guidance.
  let gitRoot=false;try{await fs.lstat(path.join(current,'.git'));gitRoot=true;}catch{}
  for(const directory of gitRoot?directories:[root])if(budget>0)await addGuidance(directory);
  const names=await fs.readdir(root,{withFileTypes:true});
  const candidates=names.filter(e=>e.isFile()&&!e.isSymbolicLink()&&/^(?:readme(?:\.[\w-]+)?|(?:project[-_]context|forge[-_]context|handoff|status)(?:\.md)?)$/i.test(e.name)).slice(0,4);
  for(const entry of candidates){const file=await textFile(path.join(root,entry.name),12_000);if(file)documents.push({...file,name:entry.name});}
  if(includeEnvironment)for(const name of ['.env','.env.local','.env.development','.env.production']){
    try{const file=path.join(root,name),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>300_000)continue;environment.push({file:name,variables:environmentNames(await fs.readFile(file,'utf8'))});}
    catch(error){if(error.code!=='ENOENT')environment.push({file:name,variables:[],error:'Access unavailable'});}
  }
  const listing=await new Workspace(root,dataDir||root).list('.',1);
  return {root,instructions,documents,environment,files:listing.entries.slice(0,60),environmentNote:'Names and presence only. Values are never returned. Presence does not establish authentication, subscription access, or quota.',contextNote:'Shared files and project instructions are available here. Codex and Forge keep separate chat histories.'};
}
