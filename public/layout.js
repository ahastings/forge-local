export const DEFAULT_LAYOUT=Object.freeze({sidebarWidth:235,editorWidth:360,terminalHeight:150,composerHeight:58,sidebarOpen:true,editorOpen:false,terminalOpen:false,focus:false});
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export function layoutBounds(width,height){
  return {sidebarWidth:[160,Math.max(160,Math.min(360,width*.3))],editorWidth:[260,Math.max(260,Math.min(640,width*(width<1000?.8:.42)))],terminalHeight:[80,Math.max(80,Math.min(360,height*.3))],composerHeight:[44,Math.max(44,Math.min(180,height*.23))]};
}
export function cleanLayout(saved={},width=1280,height=800){
  if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={};
  const result={...DEFAULT_LAYOUT},bounds=layoutBounds(width,height);
  for(const key of Object.keys(result)){
    if(typeof result[key]==='boolean'){if(typeof saved[key]==='boolean')result[key]=saved[key];}
    else if(typeof saved[key]==='number'&&Number.isFinite(saved[key]))result[key]=clamp(saved[key],...bounds[key]);
  }
  for(const key of Object.keys(bounds))result[key]=clamp(result[key],...bounds[key]);
  return result;
}
export function resizedPanel(key,start,delta,width,height){
  const sign=key==='sidebarWidth'?1:-1;return clamp(start+delta*sign,...layoutBounds(width,height)[key]);
}
export class PanelLayout {
  constructor({document=globalThis.document,window=globalThis.window,storage}={}){
    Object.assign(this,{document,window});this.$=id=>document.getElementById(id);this.root=document.querySelector('.shell');
    try{this.storage=storage||window.localStorage;this.state=cleanLayout(JSON.parse(this.storage.getItem('forge.layout.v1')||'{}'),window.innerWidth,window.innerHeight);}catch{this.state=cleanLayout({},window.innerWidth,window.innerHeight);}
    this.bindResize('sidebarResize','sidebarWidth','x');this.bindResize('editorResize','editorWidth','x');this.bindResize('terminalResize','terminalHeight','y');this.bindResize('composerResize','composerHeight','y');
    this.$('toggleSidebar').onclick=()=>this.set({sidebarOpen:!(this.state.sidebarOpen&&!this.state.focus),focus:false});
    this.$('toggleInspector').onclick=()=>this.set({editorOpen:!(this.state.editorOpen&&!this.state.focus),focus:false});
    this.$('closeInspector').onclick=()=>this.set({editorOpen:false});
    this.$('toggleTerminal').onclick=()=>this.set({terminalOpen:!this.state.terminalOpen,focus:false});
    this.$('focusChat').onclick=()=>this.set({focus:!this.state.focus});
    this.$('resetLayout').onclick=()=>{this.state=cleanLayout({},window.innerWidth,window.innerHeight);this.apply();this.save();};
    window.addEventListener('resize',()=>{this.state=cleanLayout(this.state,window.innerWidth,window.innerHeight);this.apply();});
    this.apply();
  }
  save(){try{this.storage?.setItem('forge.layout.v1',JSON.stringify(this.state));}catch{}}
  set(change){this.state=cleanLayout({...this.state,...change},this.window.innerWidth,this.window.innerHeight);this.apply();this.save();}
  openEditor(){this.set({editorOpen:true,focus:false});}
  apply(){
    const s=this.state;
    for(const [key,name] of Object.entries({sidebarWidth:'sidebar-width',editorWidth:'editor-width',terminalHeight:'terminal-height',composerHeight:'composer-height'}))this.root.style.setProperty('--'+name,s[key]+'px');
    this.root.classList.toggle('sidebar-collapsed',!s.sidebarOpen);this.root.classList.toggle('focus-chat',s.focus);this.root.classList.toggle('terminal-open',s.terminalOpen);
    this.$('inspector').classList.toggle('hidden',!s.editorOpen);this.$('inspector').classList.remove('revealed');
    this.$('editorResize').classList.toggle('hidden',!s.editorOpen);this.$('terminalResize').classList.toggle('hidden',!s.terminalOpen);
    this.$('terminalBody').classList.toggle('hidden',!s.terminalOpen);this.$('terminalArrow').textContent=s.terminalOpen?'⌄':'⌃';
    this.$('toggleTerminal').setAttribute('aria-expanded',String(s.terminalOpen));this.$('toggleInspector').setAttribute('aria-expanded',String(s.editorOpen&&!s.focus));this.$('toggleSidebar').setAttribute('aria-expanded',String(s.sidebarOpen&&!s.focus));
    this.$('focusChat').setAttribute('aria-pressed',String(s.focus));this.$('focusChat').setAttribute('aria-label',s.focus?'Exit focus':'Focus chat');this.$('focusChatLabel').textContent=s.focus?'Exit focus':'Focus chat';
    const bounds=layoutBounds(this.window.innerWidth,this.window.innerHeight);
    for(const [id,key] of Object.entries({sidebarResize:'sidebarWidth',editorResize:'editorWidth',terminalResize:'terminalHeight',composerResize:'composerHeight'})){
      const handle=this.$(id);handle.setAttribute('aria-valuemin',String(Math.round(bounds[key][0])));handle.setAttribute('aria-valuemax',String(Math.round(bounds[key][1])));handle.setAttribute('aria-valuenow',String(Math.round(s[key])));
    }
  }
  bindResize(id,key,axis){
    const handle=this.$(id);let drag=null;
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;event.preventDefault();drag={pointer:event.pointerId,origin:axis==='x'?event.clientX:event.clientY,size:this.state[key]};handle.setPointerCapture(event.pointerId);this.root.classList.add('resizing');
    });
    handle.addEventListener('pointermove',event=>{if(!drag||drag.pointer!==event.pointerId)return;const position=axis==='x'?event.clientX:event.clientY;this.state[key]=resizedPanel(key,drag.size,position-drag.origin,this.window.innerWidth,this.window.innerHeight);this.apply();});
    const finish=()=>{if(!drag)return;drag=null;this.root.classList.remove('resizing');this.save();};
    handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('lostpointercapture',finish);
    handle.addEventListener('dblclick',()=>this.set({[key]:DEFAULT_LAYOUT[key]}));
    handle.addEventListener('keydown',event=>{
      const negative=axis==='x'?'ArrowLeft':'ArrowUp',positive=axis==='x'?'ArrowRight':'ArrowDown',step=event.shiftKey?30:10;
      if(event.key===negative||event.key===positive){event.preventDefault();this.set({[key]:resizedPanel(key,this.state[key],event.key===negative?-step:step,this.window.innerWidth,this.window.innerHeight)});}
      else if(event.key==='Home'||event.key==='End'){event.preventDefault();this.set({[key]:layoutBounds(this.window.innerWidth,this.window.innerHeight)[key][event.key==='Home'?0:1]});}
    });
  }
}
