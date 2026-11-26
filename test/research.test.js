import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {publicAddress,publicUrl,fetchPublicPage,extractPage} from '../lib/public-web.js';
import {ResearchStore} from '../lib/research-store.js';
import {Research,searchCredential,researchMarkdown} from '../lib/research.js';
import {runAgent} from '../lib/agent.js';

async function fixture(){const folder=path.join(process.cwd(),'.local-data','research-tests');await fs.mkdir(folder,{recursive:true});return fs.mkdtemp(path.join(folder,'case-'));}
const credentialLoader=async()=>({key:'fixture-provider-secret',source:'Test credential'});
const html='<html><head><title>Official example</title><meta property="article:published_time" content="2026-11-20T00:00:00Z"></head><body><script>unsafe()</script><h1>Evidence</h1><p>There are 42 retained users.</p><table><tr><th>Month</th><th>Users</th></tr><tr><td>November</td><td>42</td></tr></table><p>More context explains the methodology and the limitations of the data being reported.</p><a href="/method">Methods</a></body></html>';
const pageFetcher=async(url,{beforeRequest})=>{await beforeRequest(url);return {url,status:200,headers:{'content-type':'text/html'},text:html};};
const candidate={id:'',name:'Example app',symbol:'APP',asset_id:'example-app',chain:'',contract:'',category:'Test',notes:''};
const claim=(id,source,extra={})=>({candidate_id:id,dimension:'adoption',statement:'The page reports 42 retained users.',source_id:source,quote:'There are 42 retained users.',stance:'support',confidence:'low',notes:'Provider-reported; not independently audited.',evidence_date:'2026-11-20',resolves_gap_id:'',...extra});

test('web retrieval rejects local, reserved, credential-bearing and quota-bypassing API URLs',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','169.254.169.254','100.64.0.1','192.168.1.2','203.0.113.4','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(ip),false,ip);
  for(const url of ['http://localhost/a','http://127.1/a','file:///a','https://user:pass@example.org','http://example.org:9000','https://example.org?api_key=private','https://api.coingecko.com/api/v3/ping'])assert.throws(()=>publicUrl(url));
  assert.equal(publicUrl('https://example.org/doc?utm_source=x#part').href,'https://example.org/doc');assert.ok(publicAddress('1.1.1.1'));assert.ok(publicAddress('2606:4700:4700::1111'));
});
test('DNS validation pins a public address and rejects private redirects before transport',async()=>{
  let calls=0,reservations=0;
  const lookup=async host=>host==='private.example.org'?[{address:'10.0.0.4',family:4}]:[{address:'1.1.1.1',family:4}];
  await assert.rejects(fetchPublicPage('https://public.example.org',{lookup,beforeRequest:async()=>reservations++,transport:async(_url,address)=>{calls++;assert.equal(address.address,'1.1.1.1');return {status:302,headers:{location:'https://private.example.org/'},text:''};}}),/private or reserved/);
  assert.equal(calls,1);assert.equal(reservations,2);
  await assert.rejects(fetchPublicPage('https://mixed.example.org',{lookup:async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}],transport:async()=>assert.fail('No connection allowed')}),/private or reserved/);
});
test('HTML extraction retains readable tables, dates and links without executing scripts',()=>{
  const page=extractPage(html);assert.equal(page.title,'Official example');assert.equal(page.publishedAt,'2026-11-20T00:00:00.000Z');assert.deepEqual(page.tables[0],[['Month','Users'],['November','42']]);assert.match(page.text,/November \| 42/);assert.doesNotMatch(page.text,/unsafe\(\)/);assert.equal(page.links[0].url,'/method');
  assert.equal(extractPage('%PDF','application/pdf').extraction,'unsupported');assert.equal(extractPage('<html><script>render()</script></html>').extraction,'limited');
});
test('search failures consume a persistent attempt and never return provider secrets',async()=>{
  const root=await fixture(),research=new Research(root,{credentialLoader,fetchImpl:async()=>({ok:false,status:429,json:async()=>({error:'fixture-provider-secret'})})});
  await research.store.setBudget({searchLimit:1,pageLimit:5});await assert.rejects(research.search({query:'official documentation'}),error=>/429/.test(error.message)&&!error.message.includes('fixture-provider-secret'));
  const reopened=new Research(root,{credentialLoader,fetchImpl:async()=>assert.fail('Budget blocks retry')});assert.equal((await reopened.status()).budget.searchAttempts,1);await assert.rejects(reopened.search({query:'try again'}),/budget exhausted/);
});
test('search snippets remain discovery records until a page is retrieved',async()=>{
  const root=await fixture(),research=new Research(root,{credentialLoader,fetchImpl:async()=>({ok:true,status:200,json:async()=>({organic_results:[{title:'Official page',link:'https://docs.example.org/page',snippet:'Possibly relevant'},{title:'Unrelated',link:'https://other.org/page',snippet:'Other'}]})})});
  const result=await research.search({query:'retained users',domains:['example.org'],limit:5});assert.equal(result.sources.length,1);assert.equal(result.sources[0].status,'discovered');assert.equal(result.sources[0].textPath,undefined);assert.doesNotMatch(JSON.stringify(result),/fixture-provider-secret/);
});
test('page snapshots are cached without new requests and changed versions keep old evidence readable',async()=>{
  const root=await fixture(),research=new Research(root,{pageFetcher});const first=await research.fetchSource({url:'https://example.org/report',refresh:false});assert.equal(first.source.status,'retrieved');assert.equal(first.source.tableCount,1);
  const second=await research.fetchSource({url:'https://example.org/report',refresh:false});assert.equal(second.cached,true);assert.equal((await research.store.read()).budget.pageAttempts,1);
  research.pageFetcher=async(url,{beforeRequest})=>{await beforeRequest(url);return {url,status:200,headers:{'content-type':'text/html'},text:html.replace('42 retained','50 retained')};};
  const changed=await research.fetchSource({url:'https://example.org/report',refresh:true});assert.notEqual(changed.source.id,first.source.id);assert.match((await research.readSource(first.source.id)).text,/42 retained/);assert.equal((await research.store.read()).budget.pageAttempts,2);
});
test('supporting claims require exact snapshot quotes and can resolve an explicit matching gap',async()=>{
  const root=await fixture(),research=new Research(root,{pageFetcher}),asset=await research.store.saveCandidate(candidate),source=await research.fetchSource({url:'https://example.org/report'});
  await assert.rejects(research.store.saveEvidence(claim(asset.id,source.source.id,{quote:'A fabricated sentence'})),/exact quote/);
  const gap=await research.store.saveEvidence(claim(asset.id,'',{stance:'missing',quote:'',statement:'How many retained users exist?'}));
  const saved=await research.store.saveEvidence(claim(asset.id,source.source.id,{resolves_gap_id:gap.id}));assert.equal(saved.quoteMatched,true);assert.equal((await research.store.read()).evidence.find(item=>item.id===gap.id).resolvedBy,saved.id);
  const summary=await research.store.summary();assert.equal(summary.candidates[0].coverage,1);assert.ok(summary.candidates[0].missingDimensions.includes('holder_benefit'));assert.match(researchMarkdown(summary),/Source: https:\/\/example.org\/report/);
});
test('blocked pages and inferred cache status cannot back a supposedly quoted claim',async()=>{
  const root=await fixture(),research=new Research(root,{pageFetcher:async(url,{beforeRequest})=>{await beforeRequest(url);return {url,status:403,headers:{'content-type':'text/html'},text:html};}}),asset=await research.store.saveCandidate(candidate);
  const source=await research.fetchSource({url:'https://example.org/blocked'});assert.equal(source.source.status,'blocked');await assert.rejects(research.store.saveEvidence(claim(asset.id,source.source.id)),/exact quote/);
});
test('candidate identity uses provider IDs or chain/contract rather than collapsing matching tickers',async()=>{
  const store=new ResearchStore(await fixture());const first=await store.saveCandidate(candidate),second=await store.saveCandidate({...candidate,name:'Other app',asset_id:'other-app'});assert.notEqual(first.id,second.id);
  assert.equal((await store.saveCandidate({...candidate,name:'Updated name'})).id,first.id);assert.equal((await store.read()).candidates.length,2);
});
test('persistent budgets serialize concurrent reservations and read-only roots cannot spend or write',async()=>{
  const root=await fixture(),store=new ResearchStore(root);await store.setBudget({searchLimit:1,pageLimit:1});const results=await Promise.allSettled([store.reserve('search','first'),store.reserve('search','second')]);assert.equal(results.filter(item=>item.status==='fulfilled').length,1);assert.equal((await store.read()).budget.searchAttempts,1);
  const readOnly=new ResearchStore(root,{readOnly:true});await assert.rejects(readOnly.reserve('page','https://example.org'),/read-only/);await assert.rejects(readOnly.saveCandidate(candidate),/read-only/);
});
test('credential resolution reads the named shared variable without copying or exposing values',async()=>{
  const root=await fixture(),shared=path.join(root,'shared');await fs.mkdir(shared);const file=path.join(shared,'.env');await fs.writeFile(file,'SERPAPI_KEY="saved-fixture-key"\nOTHER_KEY=leave-alone\n');const before=await fs.readFile(file,'utf8');
  const result=await searchCredential(root,{sharedEnvFile:file,skipEnvironment:true});assert.equal(result.key,'saved-fixture-key');assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(await fs.stat(path.join(root,'.env')).catch(()=>null),null);
});
test('baseline imports verify cache hashes, preserve historical dates and leave original counters unchanged',async()=>{
  const root=await fixture(),cache=path.join(root,'cache');await fs.mkdir(cache);const raw=JSON.stringify({url:'https://example.org/report',httpStatus:200,requestedAt:'2026-11-20T00:00:00Z',text:html});await fs.writeFile(path.join(cache,'page.json'),raw);const counter='{"attempts":[{"status":"finished"}]}';await fs.writeFile(path.join(cache,'request-budget.json'),counter);
  const baseline={generatedAt:'2026-11-20T00:00:00Z',coinGeckoBudget:{cap:100,used:1},markets:[{id:'example-app',name:'Example app',symbol:'APP'}],missingForAll:['Unlock totals unknown'],sources:[{file:'cache/page.json',url:'https://example.org/report',sha256:crypto.createHash('sha256').update(raw).digest('hex')},{file:'cache/page.json',url:'https://example.org/report',sha256:'wrong'}]};await fs.writeFile(path.join(root,'baseline.json'),JSON.stringify(baseline));
  const research=new Research(root,{credentialLoader});const imported=await research.importSnapshot('baseline.json');assert.equal(imported.sources,1);assert.equal(imported.candidates,1);assert.equal(imported.warnings.length,1);const state=await research.status();assert.equal(state.sources[0].status,'historical');assert.equal(state.sources[0].retrievedAt,'2026-11-20T00:00:00.000Z');assert.equal(state.budget.pageAttempts,0);assert.equal(state.externalCounters[0].attempts,1);assert.equal(await fs.readFile(path.join(cache,'request-budget.json'),'utf8'),counter);assert.equal((await research.importSnapshot('baseline.json')).alreadyImported,true);
});
test('source snapshot traversal and tampering are rejected',async()=>{
  const root=await fixture(),research=new Research(root,{pageFetcher});const source=await research.fetchSource({url:'https://example.org/report'});await fs.writeFile(path.join(root,source.source.textPath),'altered');await assert.rejects(research.readSource(source.source.id),/content changed/);
  await research.store.mutate(state=>{state.sources[0].textPath='../outside.txt';});await assert.rejects(research.readSource(source.source.id),/outside/);
});
test('retrieved and historical search pages stay discovery-only and cannot support quoted claims',async()=>{
  const root=await fixture(),research=new Research(root,{pageFetcher}),asset=await research.store.saveCandidate(candidate);
  const fetched=await research.fetchSource({url:'https://www.bing.com/search?q=example'});assert.equal(fetched.source.status,'discovered');
  await assert.rejects(research.store.saveEvidence(claim(asset.id,fetched.source.id)),/exact quote/);
  const raw=JSON.stringify({url:'https://www.google.com/search?q=example',httpStatus:200,text:html});await fs.writeFile(path.join(root,'search.json'),raw);
  await fs.writeFile(path.join(root,'baseline.json'),JSON.stringify({markets:[],sources:[{file:'search.json',url:'https://www.google.com/search?q=example',sha256:crypto.createHash('sha256').update(raw).digest('hex')}]}));
  await research.importSnapshot('baseline.json');const imported=(await research.store.read()).sources.find(source=>source.originPath==='search.json');assert.equal(imported.status,'discovered');
  await assert.rejects(research.store.saveEvidence(claim(asset.id,imported.id)),/exact quote/);
  const legacy=await research.store.recordSource({url:'https://www.bing.com/search?q=legacy',status:'historical',text:'There are 42 retained users.'});
  await assert.rejects(research.store.saveEvidence(claim(asset.id,legacy.id)),/exact quote/);
});
test('native agent research tools return actual evidence to subsequent model rounds',async()=>{
  const root=await fixture(),research=new Research(root,{pageFetcher}),session={root,messages:[{role:'user',content:'Retrieve a source and save a research candidate.'}],usage:{calls:0,input:0,output:0}};let calls=0;
  await runAgent({run:{controller:new AbortController()},session,key:'mock',config:{maxRounds:3},workspace:{root},researchTools:(name,args)=>research.tool(name,args),emit:()=>{},save:async()=>{},callModel:async request=>{
    if(++calls===1)return {status:'completed',output:[{type:'function_call',name:'fetch_source',call_id:'page',arguments:JSON.stringify({url:'https://example.org/report',refresh:false})}]};
    if(calls===2){assert.match(request.input.at(-1).output,/42 retained users/);return {status:'completed',output:[{type:'function_call',name:'save_candidate',call_id:'candidate',arguments:JSON.stringify(candidate)}]};}
    return {status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Source retrieved; candidate saved. Evidence gaps remain.'}]}]};
  }});assert.equal((await research.store.read()).candidates.length,1);assert.equal(session.messages.at(-1).error,undefined);
});
test('timed-out searches retain their reservation and do not silently retry',async()=>{
  const root=await fixture();let requests=0;const research=new Research(root,{credentialLoader,fetchImpl:async()=>{requests++;throw new DOMException('Slow provider','TimeoutError');}});
  await assert.rejects(research.search({query:'official documents'}),/timed out.*counted/);assert.equal(requests,1);assert.equal((await research.store.read()).budget.searchAttempts,1);
});
test('notebook pagination exposes saved sources even before they support a quoted claim',async()=>{
  const root=await fixture(),research=new Research(root,{credentialLoader});await research.store.discovered([{url:'https://example.org/one',title:'One'},{url:'https://example.org/two',title:'Two'}],'examples');
  const first=await research.tool('research_notebook',{candidate_id:'',offset:0,limit:1}),next=await research.tool('research_notebook',{candidate_id:'',offset:1,limit:1});assert.equal(first.sources.length,1);assert.equal(first.nextSourceOffset,1);assert.notEqual(first.sources[0].id,next.sources[0].id);assert.equal(first.evidence.length,0);
});
