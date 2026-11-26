import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Workspace,atomicJson} from './workspace.js';
import {safeText} from './project-context.js';
import {publicUrl,discoveryPage} from './public-web.js';

export const DIMENSIONS=['adoption','holder_benefit','dilution','valuation','operations'];
export const RESEARCH_FILE='research/forge/research.json';
const locks=new Map(),digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const text=(value,max=3000)=>safeText(String(value??'').trim()).slice(0,max);
const empty=()=>({schemaVersion:1,revision:0,sources:[],candidates:[],evidence:[],requests:[],budget:{searchLimit:20,pageLimit:60,searchAttempts:0,pageAttempts:0},created:new Date().toISOString()});
export class ResearchStore {
  constructor(root,{readOnly=false}={}){this.root=root;this.readOnly=readOnly;this.workspace=new Workspace(root,root);}
  async location(relative=RESEARCH_FILE,create=false){return this.workspace.resolve(relative,{create});}
  async read(){try{const file=await this.location();const stat=await fs.stat(file);if(stat.size>12_000_000)throw new Error('Research notebook exceeds 12 MB.');const state=JSON.parse(await fs.readFile(file,'utf8'));if(state.schemaVersion!==1||!Array.isArray(state.sources)||!Array.isArray(state.candidates)||!Array.isArray(state.evidence))throw new Error('Unsupported research notebook format.');
    for(const source of state.sources)if(['historical','retrieved','partial'].includes(source.status)&&discoveryPage(source.url)){source.status='discovered';source.note='Search results are discovery only; retrieve a linked primary page before saving quoted evidence. '+(source.note||'');}
    return state;}catch(error){if(error.code==='ENOENT')return empty();throw error;}}
  async mutate(change){
    if(this.readOnly)throw new Error('Research writes are disabled in a read-only reference project.');
    const previous=locks.get(this.root)||Promise.resolve();let release;const pending=new Promise(resolve=>{release=resolve;});locks.set(this.root,pending);await previous;
    try{const state=await this.read(),before=JSON.stringify(state);const result=await change(state);const file=await this.location(RESEARCH_FILE,true);await fs.mkdir(path.dirname(file),{recursive:true});await this.location(RESEARCH_FILE,true);
      const current=await this.read();if(current.revision!==state.revision||current.revision&&JSON.stringify(current)!==before)throw new Error('Research notebook changed in another editor. Reload before saving.');
      state.revision++;state.updated=new Date().toISOString();if(Buffer.byteLength(JSON.stringify(state))>12_000_000)throw new Error('Research notebook would exceed 12 MB. Archive it before adding more records.');await atomicJson(file,state);return result;
    }finally{release();if(locks.get(this.root)===pending)locks.delete(this.root);}
  }
  async reserve(kind,request){
    return this.mutate(state=>{const used=kind==='search'?'searchAttempts':'pageAttempts',limit=kind==='search'?'searchLimit':'pageLimit';if(state.budget[used]>=state.budget[limit])throw new Error(`${kind==='search'?'Search':'Page'} request budget exhausted (${state.budget[used]}/${state.budget[limit]}). Increase it explicitly in Research → Budget.`);
      state.budget[used]++;const record={id:crypto.randomUUID(),kind,request:text(request,700),time:new Date().toISOString(),status:'attempted'};state.requests.push(record);return record.id;});
  }
  async completeRequest(id,status){return this.mutate(state=>{const request=state.requests.find(item=>item.id===id);if(request)request.status=text(status,80);});}
  async setBudget({searchLimit,pageLimit}){if(!Number.isInteger(searchLimit)||searchLimit<0||searchLimit>2000||!Number.isInteger(pageLimit)||pageLimit<0||pageLimit>5000)throw new Error('Use whole-number research limits: 0–2,000 searches and 0–5,000 pages.');return this.mutate(state=>Object.assign(state.budget,{searchLimit,pageLimit}));}
  async discovered(results,query){return this.mutate(state=>results.map(result=>{let url;try{url=publicUrl(result.url).href;}catch{return null;}const id='search_'+digest(url).slice(0,20);let source=state.sources.find(item=>item.id===id);if(!source){source={id,url,title:text(result.title,300),snippet:text(result.snippet,1000),discoveredAt:new Date().toISOString(),query:text(query,500),status:'discovered',note:'Search result only; page content has not been retrieved.'};state.sources.push(source);}return source;}).filter(Boolean));}
  async recordSource(source){
    const hash=digest(source.text||''),id='src_'+digest(source.url).slice(0,12)+'_'+hash.slice(0,16)+'_'+source.status;
    if(source.text){const relative='research/forge/snapshots/'+id+'.txt',file=await this.location(relative,true);await fs.mkdir(path.dirname(file),{recursive:true});await this.location(relative,true);try{await fs.writeFile(file,source.text,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}}
    return this.mutate(state=>{let saved=state.sources.find(item=>item.id===id);const {text:body,...metadata}=source;const now=new Date().toISOString();if(!saved){saved={...metadata,id,contentHash:hash,retrievedAt:metadata.retrievedAt===undefined?now:metadata.retrievedAt,textPath:body?'research/forge/snapshots/'+id+'.txt':null};state.sources.push(saved);}else saved.lastCheckedAt=now;return saved;});
  }
  async snapshot(id){const state=await this.read(),source=state.sources.find(item=>item.id===id);if(!source)throw new Error('Source not found.');if(!source.textPath)return {source,text:''};const file=await this.location(source.textPath);const body=await fs.readFile(file,'utf8');if(digest(body)!==source.contentHash)throw new Error('Saved source content changed. Refetch it before citing.');return {source,text:body};}
  async cached(url){const state=await this.read();return state.sources.findLast(source=>(source.url===url||source.requestedUrl===url)&&['retrieved','partial'].includes(source.status)&&Date.now()-Date.parse(source.lastCheckedAt||source.retrievedAt)<60*60_000);}
  async saveCandidate(data){
    if(!text(data.name,200))throw new Error('Give the candidate a name.');
    return this.mutate(state=>{let candidate=data.id?state.candidates.find(item=>item.id===data.id):null;if(data.id&&!candidate)throw new Error('Candidate not found.');
      const identity={assetId:text(data.asset_id,150),chain:text(data.chain,100),contract:text(data.contract,200)};
      if(!candidate&&(identity.assetId||identity.contract))candidate=state.candidates.find(item=>identity.assetId&&item.assetId===identity.assetId||identity.contract&&item.contract===identity.contract&&item.chain===identity.chain);
      const fields={...identity,name:text(data.name,200),symbol:text(data.symbol,30),category:text(data.category,150),notes:text(data.notes,3000),updated:new Date().toISOString()};
      if(candidate)Object.assign(candidate,fields);else{candidate={id:'candidate_'+crypto.randomUUID(),...fields,created:new Date().toISOString()};state.candidates.push(candidate);}return candidate;});
  }
  async saveEvidence(data){
    if(!DIMENSIONS.includes(data.dimension)||!['support','contradict','missing'].includes(data.stance)||!['unknown','low','medium','high'].includes(data.confidence))throw new Error('Choose a valid research dimension, stance and confidence.');
    const statement=text(data.statement,3000),quote=text(data.quote,2000);if(!statement)throw new Error('Include a specific claim or missing-evidence question.');
    let source=null;
    if(data.stance!=='missing'){
      const snapshot=await this.snapshot(data.source_id);source=snapshot.source;
      if(!['retrieved','partial','historical'].includes(source.status)||!quote||!snapshot.text.replace(/\s+/g,' ').includes(quote.replace(/\s+/g,' ')))throw new Error('Evidence needs an exact quote from a retrieved source snapshot. Search snippets and blocked pages do not verify claims.');
    }
    if(data.evidence_date&&!Number.isFinite(Date.parse(data.evidence_date)))throw new Error('Use a valid evidence date or leave it unknown.');
    return this.mutate(state=>{if(!state.candidates.some(item=>item.id===data.candidate_id))throw new Error('Choose a saved candidate.');
      const match=state.evidence.find(item=>item.candidateId===data.candidate_id&&item.dimension===data.dimension&&item.statement===statement&&item.sourceId===(source?.id||null));
      const record={id:match?.id||'evidence_'+crypto.randomUUID(),candidateId:data.candidate_id,dimension:data.dimension,statement,sourceId:source?.id||null,quote:source?quote:'',quoteMatched:!!source,stance:data.stance,confidence:data.stance==='missing'?'unknown':data.confidence,evidenceDate:data.evidence_date||null,notes:text(data.notes,3000),recordedAt:new Date().toISOString()};
      if(data.resolves_gap_id){const gap=state.evidence.find(item=>item.id===data.resolves_gap_id&&item.stance==='missing'&&item.candidateId===record.candidateId&&item.dimension===record.dimension);if(!gap||!record.quoteMatched)throw new Error('Resolve a matching candidate/dimension gap with quoted source evidence.');gap.resolvedBy=record.id;}
      if(match)Object.assign(match,record);else state.evidence.push(record);return record;});
  }
  async summary(){const state=await this.read();return {...state,path:RESEARCH_FILE,dimensions:DIMENSIONS,candidates:state.candidates.map(candidate=>{const claims=state.evidence.filter(item=>item.candidateId===candidate.id);return {...candidate,coverage:DIMENSIONS.filter(dimension=>claims.some(item=>item.dimension===dimension&&item.quoteMatched)).length,missingDimensions:DIMENSIONS.filter(dimension=>!claims.some(item=>item.dimension===dimension&&item.quoteMatched))};})};}
}
