import {markdown} from './markdown.js';
const key=root=>root?.replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
export class ProjectLibrary {
  constructor({api,getState,selectProject,selectChat,afterChange,beforeChange,toast,isBusy}){
    Object.assign(this,{api,getState,selectProject,selectChat,afterChange,beforeChange,toast,isBusy});this.$=id=>document.getElementById(id);this.tab='overview';this.request=0;
    const action=fn=>async event=>{try{await fn(event);}catch(error){toast(error.message,true);this.render(getState());}};
    this.$('projectSwitcher').onchange=action(()=>selectProject(this.$('projectSwitcher').value));
    this.$('projectLibraryButton').onclick=()=>this.open();this.$('chooseProject').onclick=()=>this.open();
    this.$('projectSearch').oninput=()=>this.renderList();
    this.$('refreshProjects').onclick=action(async()=>{await api('projects-refresh',{});await afterChange(false);this.renderList();toast(getState().catalogStatus.message);});
    this.$('projectAdd').onclick=()=>{this.$('projectPath').value='';this.$('folderDialog').showModal();};
    this.$('projectCreate').onclick=()=>{const root=this.selected?.root||getState().sessions.find(s=>s.id===getState().activeSessionId)?.root||'';this.$('newProjectParent').value=root.replace(/[\\/][^\\/]+[\\/]?$/,'');this.$('newProjectName').value='';this.$('newProjectDialog').showModal();};
    this.$('newProjectBrowse').onclick=action(async()=>{const result=await api('browse',{});if(result.path)this.$('newProjectParent').value=result.path;});
    this.$('newProjectForm').onsubmit=action(async event=>{event.preventDefault();if(!beforeChange())return;await api('project-create',{name:this.$('newProjectName').value.trim(),parent:this.$('newProjectParent').value.trim()});await afterChange();this.close();});
    this.$('continueProject').onclick=action(async()=>{if(await selectProject(this.selected.id)!==false)this.close();});
    this.$('newProjectChat').onclick=action(async()=>{if(await selectProject(this.selected.id,true)!==false)this.close();});
    for(const button of document.querySelectorAll('[data-project-tab]'))button.onclick=()=>{this.tab=button.dataset.projectTab;this.renderDetails();};
  }
  close(){for(const id of ['projectDialog','folderDialog','newProjectDialog'])this.$(id).close();}
  render(state){
    const active=state.sessions.find(s=>s.id===state.activeSessionId),select=this.$('projectSwitcher');select.replaceChildren();
    if(!active){const option=document.createElement('option');option.textContent='Choose a project…';option.value='';select.append(option);}
    for(const project of state.projects||[]){const option=document.createElement('option');option.value=project.id;option.textContent=project.name+(project.chatCount?` (${project.chatCount})`:'');option.title=project.root;option.selected=key(project.root)===key(active?.root);select.append(option);}
    if(this.$('projectDialog').open)this.renderList();
  }
  open(){
    if(!this.getState())return this.toast('Wait for Forge to connect.',true);
    if(this.isBusy())return this.toast('Wait for the active task or stop it before switching projects.',true);
    this.$('projectSearch').value='';this.renderList();this.$('projectDialog').showModal();
    const state=this.getState(),active=state.sessions.find(s=>s.id===state.activeSessionId),project=state.projects.find(p=>key(p.root)===key(active?.root))||state.projects[0];
    if(project)void this.preview(project);else this.$('projectDetailBody').textContent='Add an existing folder or create a project to begin.';
  }
  renderList(){
    const state=this.getState(),query=this.$('projectSearch').value.toLowerCase(),list=this.$('projectChoices');list.replaceChildren();
    this.$('projectCatalogStatus').textContent=state.catalogStatus?.message||'Your saved project folders.';
    for(const project of state.projects.filter(p=>(p.name+' '+p.root).toLowerCase().includes(query))){
      const button=document.createElement('button'),name=document.createElement('strong'),meta=document.createElement('small');button.type='button';button.className='project-choice'+(this.selected?.id===project.id?' active':'');
      name.textContent=project.name;meta.textContent=`${project.chatCount} Forge chats${project.sources?.includes('codex')?' · Codex':''}`;button.title=project.root;button.append(name,meta);button.onclick=()=>void this.preview(project);list.append(button);
    }
    if(!list.children.length){const empty=document.createElement('p');empty.className='muted small';empty.textContent='No matching projects.';list.append(empty);}
  }
  async preview(project){
    const request=++this.request;this.selected=project;this.context=null;this.renderList();this.$('projectPreviewName').textContent=project.name;this.$('projectPreviewPath').textContent=project.root;this.$('projectDetailBody').textContent='Reading project overview…';
    this.$('continueProject').disabled=true;this.$('newProjectChat').disabled=true;
    try{const context=await this.api('project-context?id='+encodeURIComponent(project.id));if(request!==this.request)return;this.context=context;this.$('continueProject').disabled=false;this.$('newProjectChat').disabled=false;this.renderDetails();}
    catch(error){if(request===this.request)this.$('projectDetailBody').textContent=error.message;}
  }
  renderDetails(){
    for(const button of document.querySelectorAll('[data-project-tab]')){const chosen=button.dataset.projectTab===this.tab;button.classList.toggle('active',chosen);button.setAttribute('aria-selected',String(chosen));}
    const body=this.$('projectDetailBody');body.replaceChildren();if(!this.context)return;
    const add=(tag,text,className)=>{const element=document.createElement(tag);element.textContent=text;if(className)element.className=className;body.append(element);return element;};
    if(this.tab==='chats'){
      const chats=this.getState().sessions.filter(s=>key(s.root)===key(this.selected.root));
      if(!chats.length)add('p','No Forge chats yet. Start a new chat below.','muted');
      for(const chat of chats){const button=add('button',chat.title,'project-chat');button.type='button';button.onclick=async()=>{try{if(await this.selectChat(chat.id)!==false)this.close();}catch(error){this.toast(error.message,true);}};const reply=chat.messages.findLast(m=>m.role==='assistant');if(reply)add('p',reply.content.slice(0,350)+(reply.content.length>350?'…':''),'chat-excerpt');}
      add('p','Codex chats stay in Codex. Forge chats stay saved here; both apps can work on the same project files.','muted small');
    }else if(this.tab==='environment'){
      add('p',this.context.environmentNote,'muted small');
      if(!this.context.environment.length)add('p','No local .env files found in this project.','muted');
      for(const source of this.context.environment){add('h3',source.file);if(source.error){add('p',source.error);continue;}const table=document.createElement('table');table.className='environment-table';const head=document.createElement('tr');for(const title of ['Variable','Status']){const th=document.createElement('th');th.textContent=title;head.append(th);}table.append(head);for(const variable of source.variables){const row=document.createElement('tr');for(const value of [variable.name,variable.configured?'Value present':'Empty']){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}table.append(row);}body.append(table);}
    }else{
      add('p','This is the same folder used by your other tools. Changes are visible in both apps.','muted small');
      add('p','Start projects in Codex, then select them here. For a folder created in Forge, open that folder in Codex once to add it there.','muted small');
      add('h3','Shared progress');
      if(this.context.sharedProgress)add('p','Enabled: both agents read FORGE-CONTEXT.md through the project instructions. Forge records completed tool checks there; Codex is instructed to update Current status.','muted small');
      else{add('p','Enable this to create FORGE-CONTEXT.md and add a reference to the project’s AGENTS instructions. Existing instructions are preserved with recoverable backups.','muted small');const button=add('button','Enable shared progress','secondary');button.type='button';button.onclick=async()=>{try{if(!this.beforeChange())return;button.disabled=true;await this.api('project-share',{id:this.selected.id});await this.preview(this.selected);this.toast('Shared progress enabled for this project.');}catch(error){button.disabled=false;this.toast(error.message,true);}};}
      if(this.context.git?.available){add('h3','Current changes on disk');add('p',this.context.git.changes.map(change=>change.status+' '+change.path).join('\n')||'Git reports no uncommitted changes.','chat-excerpt');}
      add('h3','Project files');add('p',this.context.files.map(file=>file.path+(file.type==='folder'?'/':'')).join('  ·  ')||'This folder is empty.','project-file-summary');
      add('h3','Instructions loaded for the agent');
      if(!this.context.instructions.length)add('p','No AGENTS.md instructions found.','muted small');
      for(const file of this.context.instructions){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=file.path;pre.textContent=file.text+(file.truncated?'\n[Preview truncated]':'');details.append(summary,pre);body.append(details);}
      for(const file of this.context.documents){add('h3',file.name);const section=document.createElement('div');section.className='message-body project-document';markdown(section,file.text);body.append(section);}
      if(this.context.recentChats?.length){add('h3','From earlier Forge chats');add('p','These are saved notes, not a fresh verification of the code.','muted small');for(const chat of this.context.recentChats){add('strong',chat.title);add('p',chat.lastReply,'chat-excerpt');}}
    }
  }
}
