const labels={adoption:'Adoption',holder_benefit:'Token-holder benefit',dilution:'Dilution',valuation:'Valuation',operations:'Operations / support'};
const node=(tag,text='',className='')=>{const element=document.createElement(tag);element.textContent=text;if(className)element.className=className;return element;};
const short=(text,length=190)=>text.length>length?text.slice(0,length)+'…':text;
export class ResearchPanel {
  constructor({api,getState,syncState,toast}){
    Object.assign(this,{api,getState,syncState,toast});this.$=id=>document.getElementById(id);this.tab='compare';this.busy=false;
    this.$('researchButton').onclick=()=>void this.open();this.$('researchRefresh').onclick=()=>void this.perform('Refreshing notebook',()=>this.load());
    for(const button of document.querySelectorAll('[data-research-tab]'))button.onclick=()=>{this.tab=button.dataset.researchTab;this.showTab();};
    const form=(id,fn)=>this.$(id).onsubmit=event=>{event.preventDefault();void this.perform('Working',fn);};
    form('researchSearchForm',()=>this.action('search_web',{query:this.$('researchQuery').value,domains:this.$('researchDomains').value.split(',').map(s=>s.trim()).filter(Boolean),limit:Number(this.$('researchSearchLimit').value)}));
    form('researchFetchForm',()=>this.action('fetch_source',{url:this.$('researchUrl').value,refresh:this.$('researchForceRefresh').checked}));
    form('researchCandidateForm',async()=>{const data=Object.fromEntries(new FormData(this.$('researchCandidateForm')));const result=await this.action('save_candidate',data);if(!data.id)this.$('researchCandidateForm').reset();return result;});
    form('researchEvidenceForm',async()=>{const result=await this.action('save_evidence',Object.fromEntries(new FormData(this.$('researchEvidenceForm'))));this.$('researchEvidenceForm').reset();return result;});
    form('researchImportForm',()=>this.action('import_research_snapshot',{path:this.$('researchImportPath').value.trim()}));
    form('researchBudgetForm',()=>api('research/settings',{projectId:this.projectId,sharedEnvFile:this.$('researchSharedEnv').value,searchLimit:Number(this.$('researchSearchCap').value),pageLimit:Number(this.$('researchPageCap').value)}));
    this.$('researchEditCandidate').onchange=()=>{const form=this.$('researchCandidateForm'),candidate=this.data.candidates.find(item=>item.id===this.$('researchEditCandidate').value);for(const name of ['name','symbol','chain','contract','category','notes','asset_id'])form.elements[name].value=candidate?(name==='asset_id'?candidate.assetId:candidate[name])||'':'';};
    this.$('researchEvidenceFilter').onchange=()=>this.renderEvidence();this.$('researchClaimCandidate').onchange=()=>this.renderGaps();this.$('researchClaimDimension').onchange=()=>this.renderGaps();
    this.$('researchSourcePrevious').onclick=()=>void this.source(this.sourceId,Math.max(0,this.sourceOffset-20000));this.$('researchSourceNext').onclick=()=>void this.source(this.sourceId,this.sourceOffset+20000);
  }
  message(text,error=false){this.$('researchMessage').textContent=text;this.$('researchMessage').classList.toggle('error',error);}
  async open(){
    try{await this.syncState?.();}catch(error){return this.toast(error.message,true);}
    const state=this.getState(),session=state?.sessions.find(item=>item.id===state.activeSessionId),project=state?.projects.find(item=>item.root.toLowerCase()===session?.root.toLowerCase());if(!project)return this.toast('Choose a project before opening research.',true);
    this.projectId=project.id;this.$('researchProjectName').textContent=project.name;this.$('researchDialog').showModal();this.showTab();await this.perform('Loading notebook',()=>this.load());
  }
  async load(){
    this.data=await this.api('research?projectId='+encodeURIComponent(this.projectId));this.render();return null;
  }
  async refreshIfOpen(){if(this.$('researchDialog').open&&!this.busy)try{await this.load();}catch(error){this.message(error.message,true);}}
  async action(action,args){return this.api('research/action',{projectId:this.projectId,action,args});}
  async perform(label,fn){
    if(this.busy)return;this.busy=true;this.message(label+'…');
    const buttons=[...this.$('researchDialog').querySelectorAll('button[type="submit"]')];for(const button of buttons)button.disabled=true;
    try{const result=await fn();if(result!==null)await this.load();let message=result?.error||result?.note||'Notebook updated.';
      if(typeof result?.sources==='number')message=`Imported ${result.sources} source caches and ${result.candidates} candidates. ${result.warnings.length} caches skipped. Original files and counters were preserved.`;
      else if(Array.isArray(result?.sources))message=`Saved ${result.sources.length} search results. Fetch the relevant pages before citing them.`;
      else if(result?.source)message=`Saved ${result.source.status} source · ${result.source.httpStatus||'no HTTP status'} · ${result.source.tableCount||0} extracted tables. ${result.note||''}`;
      this.message(message,!!result?.error);
    }catch(error){this.message(error.message,true);try{await this.load();}catch{}}
    finally{this.busy=false;for(const button of buttons)button.disabled=false;}
  }
  showTab(){for(const button of document.querySelectorAll('[data-research-tab]')){const chosen=button.dataset.researchTab===this.tab;button.classList.toggle('active',chosen);button.setAttribute('aria-selected',String(chosen));this.$('research-'+button.dataset.researchTab).classList.toggle('hidden',!chosen);}}
  options(id,records,emptyLabel){const select=this.$(id),value=select.value;select.replaceChildren();if(emptyLabel!==undefined){const option=node('option',emptyLabel);option.value='';select.append(option);}for(const record of records){const option=node('option',record.name||record.title||record.id);option.value=record.id;select.append(option);}if([...select.options].some(option=>option.value===value))select.value=value;}
  tag(text){return node('span',text,'research-tag '+text);}
  sourceButton(id){const button=node('button','View source','research-claim-source');button.type='button';button.onclick=()=>void this.source(id);return button;}
  render(){
    const data=this.data,budget=data.budget;this.$('researchCounts').textContent=`${data.candidates.length} candidates · ${data.sources.length} sources · ${data.evidence.filter(item=>item.quoteMatched).length} quoted claims · searches ${budget.searchAttempts}/${budget.searchLimit} · pages ${budget.pageAttempts}/${budget.pageLimit}`;
    this.$('researchProviderStatus').textContent=`SerpAPI: ${data.search.configured?'credential present':'not configured'} (${data.search.source}). Authentication and quota are checked when a search runs.`;
    this.$('researchExportJson').href='/api/research/export?projectId='+encodeURIComponent(this.projectId);this.$('researchExportMarkdown').href='/api/research/export?format=markdown&projectId='+encodeURIComponent(this.projectId);
    this.options('researchEditCandidate',data.candidates,'New candidate');this.options('researchClaimCandidate',data.candidates,'Choose candidate');this.options('researchEvidenceFilter',data.candidates,'All candidates');
    this.options('researchClaimSource',data.sources.filter(source=>['retrieved','partial','historical'].includes(source.status)).map(source=>({...source,title:source.title+' · '+source.status})),'No source / missing evidence');
    this.renderGaps();this.renderCompare();this.renderSources();this.renderEvidence();
    const summary=this.$('researchBudgets');summary.replaceChildren();summary.append(node('p',data.budgetNote,'research-note'),node('p',`Search: ${budget.searchAttempts} attempts / ${budget.searchLimit}. Pages: ${budget.pageAttempts} attempts / ${budget.pageLimit}.`));
    for(const counter of data.externalCounters||[])summary.append(node('p',`${counter.provider}: ${counter.attempts}/${counter.cap??'unknown cap'} · read from ${counter.path}. The existing project adapter owns this counter.`,'research-note'));
    summary.append(node('p',`Model reasoning: ${data.model?.effort||'unknown'} · per-task round limit: ${data.model?.roundLimit||'unknown'}. Model calls are separate; choose reasoning in Settings.`,'research-note'));
    for(const [id,value] of [['researchSearchCap',budget.searchLimit],['researchPageCap',budget.pageLimit],['researchSharedEnv',data.sharedEnvFile||'']])if(document.activeElement!==this.$(id))this.$(id).value=value;
  }
  renderGaps(){const candidate=this.$('researchClaimCandidate').value,dimension=this.$('researchClaimDimension').value;this.options('researchResolveGap',this.data.evidence.filter(item=>item.candidateId===candidate&&item.dimension===dimension&&item.stance==='missing'&&!item.resolvedBy).map(item=>({id:item.id,title:short(item.statement,100)})),'Does not resolve a saved gap');}
  renderCompare(){
    const wrapper=this.$('researchCompareTable');wrapper.replaceChildren();if(!this.data.candidates.length){wrapper.append(node('p','No candidates saved yet. Add one below, import a baseline, or ask the agent to build an evidence-backed comparison.','research-note'));return;}
    const table=node('table','','research-table research-compare'),head=node('tr');for(const title of ['Candidate / identity',...this.data.dimensions.map(d=>labels[d]),'Coverage / gaps'])head.append(node('th',title));table.append(head);
    for(const candidate of this.data.candidates){const row=node('tr'),identity=node('td');const name=node('button',candidate.name+(candidate.symbol?' ('+candidate.symbol+')':''),'secondary');name.type='button';name.onclick=()=>{this.$('researchEditCandidate').value=candidate.id;this.$('researchEditCandidate').onchange();this.$('researchCandidateForm').parentElement.open=true;this.$('researchCandidateForm').scrollIntoView({block:'nearest'});};identity.append(name,node('p',candidate.assetId||'Provider ID unknown','research-note'),node('p',[candidate.chain,candidate.contract].filter(Boolean).join(' · ')||'Chain / contract not verified','research-note'));row.append(identity);
      const claims=this.data.evidence.filter(item=>item.candidateId===candidate.id);
      for(const dimension of this.data.dimensions){const cell=node('td'),matched=claims.filter(item=>item.dimension===dimension&&item.quoteMatched);if(!matched.length)cell.append(this.tag('missing'));for(const claim of matched.slice(-2)){cell.append(this.tag(claim.stance),node('p',short(claim.statement)),node('small','Confidence: '+claim.confidence));cell.append(this.sourceButton(claim.sourceId));}row.append(cell);}
      const coverage=node('td');coverage.append(node('strong',candidate.coverage+'/5 dimensions with quoted evidence'),node('p',claims.filter(item=>item.stance==='missing'&&!item.resolvedBy).length+' saved gap questions','research-note'));row.append(coverage);table.append(row);
    }
    wrapper.append(table);
  }
  renderSources(){
    const list=this.$('researchSources');list.replaceChildren();if(!this.data.sources.length)list.append(node('p','No sources saved yet. Search or fetch a public page above.','research-note'));
    for(const source of [...this.data.sources].reverse()){
      const article=node('article');article.append(node('strong',source.title||source.url),this.tag(source.status));
      try{const url=new URL(source.url);if(['http:','https:'].includes(url.protocol)){const link=node('a',source.url);link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';const paragraph=node('p');paragraph.append(link);article.append(paragraph);}}catch{}
      article.append(node('p',`Retrieved: ${source.retrievedAt||'not retrieved'} · Published: ${source.publishedAt||'unknown'} · HTTP: ${source.httpStatus??'not checked'} · Tables: ${source.tableCount||0}`,'research-note'));
      if(source.snippet)article.append(node('p',source.snippet,'research-note'));if(source.note)article.append(node('p',source.note,'research-note'));
      const actions=node('div','','research-actions');if(source.textPath){const snapshot=node('button','Read saved snapshot');snapshot.type='button';snapshot.onclick=()=>void this.source(source.id);actions.append(snapshot);}
      if(!/^https?:\/\/(?:api|pro-api)\.coingecko\.com\//i.test(source.url)){const fetch=node('button',source.status==='discovered'?'Fetch source':'Refresh source');fetch.type='button';fetch.onclick=()=>void this.perform('Fetching source',()=>this.action('fetch_source',{url:source.url,refresh:true}));actions.append(fetch);}article.append(actions);list.append(article);
    }
  }
  renderEvidence(){
    const wrapper=this.$('researchEvidenceTable'),filter=this.$('researchEvidenceFilter').value;wrapper.replaceChildren();const table=node('table','','research-table research-evidence'),heading=node('tr');for(const title of ['Candidate','Dimension / stance','Claim or missing evidence','Provenance / confidence'])heading.append(node('th',title));table.append(heading);
    for(const claim of this.data.evidence.filter(item=>!filter||item.candidateId===filter)){const row=node('tr'),candidate=this.data.candidates.find(item=>item.id===claim.candidateId),dimension=node('td');dimension.append(node('p',labels[claim.dimension]||claim.dimension),this.tag(claim.resolvedBy?'resolved':claim.stance));const statement=node('td');statement.append(node('p',claim.statement));if(claim.quote)statement.append(node('p','“'+claim.quote+'”','research-note'));if(claim.notes)statement.append(node('p',short(claim.notes,250),'research-note'));const provenance=node('td');provenance.append(node('p',claim.quoteMatched?'Quote matched to saved snapshot':'Unverified / missing'),node('p','Confidence: '+claim.confidence,'research-note'),node('p','Evidence date: '+(claim.evidenceDate||'unknown'),'research-note'));if(claim.sourceId)provenance.append(this.sourceButton(claim.sourceId));row.append(node('td',candidate?.name||claim.candidateId),dimension,statement,provenance);table.append(row);}
    wrapper.append(table);
  }
  async source(id,offset=0){
    try{const result=await this.api('research/source?projectId='+encodeURIComponent(this.projectId)+'&id='+encodeURIComponent(id)+'&offset='+offset);this.sourceId=id;this.sourceOffset=offset;this.$('researchSourceTitle').textContent=short(result.source.title||'Source snapshot',100);this.$('researchSourceMeta').textContent=`${result.source.url}\n${result.source.status} · HTTP ${result.source.httpStatus??'unknown'} · Retrieved ${result.source.retrievedAt||'unknown'} · Published ${result.source.publishedAt||'unknown'}\n${result.source.note||''}`;this.$('researchSourceText').textContent=result.text||'No readable snapshot content.';this.$('researchSourceRange').textContent=`${offset}–${Math.min(offset+result.text.length,result.totalCharacters)} of ${result.totalCharacters} characters`;this.$('researchSourcePrevious').disabled=offset===0;this.$('researchSourceNext').disabled=!result.truncated;if(!this.$('researchSourceDialog').open)this.$('researchSourceDialog').showModal();}
    catch(error){this.message(error.message,true);this.toast(error.message,true);}
  }
}
