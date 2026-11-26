import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Workspace} from './workspace.js';
import {cleanEnv} from './windows.js';

const fileName='FORGE-CONTEXT.md',start='<!-- forge-progress:start -->',end='<!-- forge-progress:end -->';
const guidance='<!-- forge-shared-context:start -->\n## Shared progress between Codex and Forge\nRead `FORGE-CONTEXT.md` at the start of work. Both apps edit this same folder. After substantive work, update its Current status section with verified changes, checks and remaining work. Preserve the managed Latest Forge run section and existing instructions. Never put API keys, environment values or private chat transcripts in this file. Recheck current files before relying on older notes.\n<!-- forge-shared-context:end -->';
async function existing(workspace,name){try{return await workspace.read(name);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function sharedProgressStatus(root){
  try{const stat=await fs.lstat(path.join(root,fileName));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>300_000)return false;return (await fs.readFile(path.join(root,fileName),'utf8')).includes(start);}catch{return false;}
}
export async function enableSharedProgress(root,dataDir){
  const workspace=new Workspace(root,dataDir);let name='AGENTS.md';
  const override=await existing(workspace,'AGENTS.override.md');if(override?.content.trim())name='AGENTS.override.md';
  const instructions=name==='AGENTS.override.md'?override:await existing(workspace,name);
  if(!instructions?.content.includes('<!-- forge-shared-context:start -->'))await workspace.write(name,(instructions?.content||'').trimEnd()+'\n\n'+guidance+'\n',instructions?.hash??null);
  const context=await existing(workspace,fileName);
  if(!context?.content.includes(start))await workspace.write(fileName,(context?.content||'# Shared project progress\n\n## Current status\nRead the project files and record verified progress here when work is completed.').trimEnd()+'\n\n## Latest Forge run\n'+start+'\nShared progress enabled. No run has been recorded yet.\n'+end+'\n',context?.hash??null);
  return {enabled:true,file:fileName,instructions:name};
}
export async function recordSharedProgress(workspace,session,status){
  if(workspace.readOnly||!await sharedProgressStatus(workspace.root))return false;
  const context=await workspace.read(fileName),messages=session.messages||[];
  const lastUser=messages.findLastIndex(message=>message.role==='user');
  const tools=messages.slice(Math.max(0,lastUser)).filter(message=>message.role==='tool'&&message.result&&message.root===workspace.root);
  const facts=tools.slice(-15).map(tool=>'- '+tool.name+(tool.result.path?' · '+tool.result.path:'')+(tool.result.exitCode!==undefined?' · exit '+tool.result.exitCode:'')+(tool.result.error?' · failed':'')).join('\n');
  const note=start+'\nUpdated: '+new Date().toISOString()+'\nStatus: '+status+'\n\n'+(facts||'No completed tool records in this run.')+'\n\nInspect the current files and changes before continuing. Chat transcripts and environment values are not copied here.\n'+end;
  const from=context.content.indexOf(start),to=context.content.indexOf(end,from);
  if(from<0||to<from)return false;
  await workspace.write(fileName,context.content.slice(0,from)+note+context.content.slice(to+end.length),context.hash);return true;
}
const runFile=promisify(execFile);
export async function gitOverview(root){
  try{
    const options={windowsHide:true,timeout:4000,maxBuffer:300_000,env:{...cleanEnv(),GIT_OPTIONAL_LOCKS:'0'}};
    const {stdout}=await runFile('git',['-c','core.fsmonitor=false','-C',root,'status','--porcelain=v1','-z','--untracked-files=normal','--','.'],options);
    const entries=stdout.split('\0').filter(Boolean),changes=[];
    for(let i=0;i<entries.length&&changes.length<80;i++){const entry=entries[i];changes.push({status:entry.slice(0,2),path:entry.slice(3)});if(/[RC]/.test(entry.slice(0,2)))i++;}
    return {available:true,changes,clipped:entries.length>80};
  }catch{return {available:false,changes:[]};}
}
