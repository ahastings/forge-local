import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PanelLayout,cleanLayout,layoutBounds,DEFAULT_LAYOUT} from '../public/layout.js';

class Element extends EventTarget {
  constructor(){super();this.classes=new Set();this.attributes=new Map();this.classList={toggle:(key,value)=>{value?this.classes.add(key):this.classes.delete(key);},add:key=>this.classes.add(key),remove:key=>this.classes.delete(key)};this.style={setProperty:()=>{}};}
  setAttribute(name,value){this.attributes.set(name,value);}
  setPointerCapture(){}
  input(type,properties={}){this.dispatchEvent(Object.assign(new Event(type,{cancelable:true}),properties));}
  click(){this.onclick();}
}
function setup(saved){
  const ids=['sidebarResize','editorResize','terminalResize','composerResize','toggleSidebar','toggleInspector','closeInspector','toggleTerminal','focusChat','resetLayout','inspector','terminalBody','terminalArrow','focusChatLabel'];
  const elements=new Map(ids.map(id=>[id,new Element()])),root=new Element(),window=new EventTarget();window.innerWidth=1440;window.innerHeight=900;
  let value=saved;
  const storage={getItem:()=>value,setItem:(_key,next)=>{value=next;}};
  const document={getElementById:id=>elements.get(id),querySelector:()=>root};
  const panel=new PanelLayout({document,window,storage});return {panel,elements,root,window,stored:()=>value,document,storage};
}
test('layout starts with an uncluttered chat and optional panels closed',()=>{
  const {panel,elements}=setup();assert.deepEqual(panel.state,DEFAULT_LAYOUT);
  assert.ok(elements.get('inspector').classes.has('hidden'));assert.ok(elements.get('terminalBody').classes.has('hidden'));
  assert.equal(elements.get('toggleTerminal').attributes.get('aria-expanded'),'false');
});
test('invalid or oversized saved layouts recover and fit the current viewport',()=>{
  for(const saved of ['not json','null','[]'])assert.doesNotThrow(()=>setup(saved));
  const state=cleanLayout({editorWidth:10000,terminalHeight:10000,composerHeight:-10,sidebarOpen:'yes'},800,600),bounds=layoutBounds(800,600);
  assert.equal(state.editorWidth,bounds.editorWidth[1]);assert.equal(state.terminalHeight,bounds.terminalHeight[1]);assert.equal(state.composerHeight,44);assert.equal(state.sidebarOpen,true);
});
test('keyboard panel sizing persists and can be restored on the next visit',()=>{
  const {panel,elements,stored}=setup();
  for(const [id,key,start] of [['sidebarResize','ArrowRight','sidebarWidth'],['editorResize','ArrowLeft','editorWidth'],['terminalResize','ArrowUp','terminalHeight'],['composerResize','ArrowUp','composerHeight']]){
    const before=panel.state[start];elements.get(id).input('keydown',{key});assert.equal(panel.state[start],before+10);
  }
  panel.openEditor();const restored=setup(stored());assert.deepEqual(restored.panel.state,panel.state);assert.ok(!restored.elements.get('inspector').classes.has('hidden'));
});
test('drag handles resize with bounds and release cleanly',()=>{
  const {panel,elements,root,window,stored}=setup();const handle=elements.get('sidebarResize');
  handle.input('pointerdown',{button:0,pointerId:7,clientX:100});handle.input('pointermove',{pointerId:7,clientX:10000});
  assert.equal(panel.state.sidebarWidth,layoutBounds(window.innerWidth,window.innerHeight).sidebarWidth[1]);
  handle.input('pointerup',{pointerId:7});assert.ok(!root.classes.has('resizing'));assert.ok(stored());
  const terminal=elements.get('terminalResize');terminal.input('pointerdown',{button:0,pointerId:8,clientY:200});terminal.input('pointermove',{pointerId:8,clientY:160});terminal.input('pointercancel',{pointerId:8});assert.equal(panel.state.terminalHeight,190);
});
test('focus view preserves panel choices and reset restores a readable default',()=>{
  const {panel,elements,root,window}=setup();panel.set({editorOpen:true,terminalOpen:true,editorWidth:440});
  elements.get('focusChat').click();assert.ok(root.classes.has('focus-chat'));assert.equal(panel.state.editorWidth,440);
  elements.get('focusChat').click();assert.ok(!root.classes.has('focus-chat'));assert.equal(panel.state.editorOpen,true);
  window.innerWidth=600;window.innerHeight=500;window.dispatchEvent(new Event('resize'));assert.ok(panel.state.terminalHeight<=150);
  elements.get('resetLayout').click();assert.equal(panel.state.editorOpen,false);assert.equal(panel.state.terminalOpen,false);assert.equal(panel.state.focus,false);
});
