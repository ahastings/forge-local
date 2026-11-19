import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChatScroll} from '../public/chat-scroll.js';

class View extends EventTarget {
  constructor(){super();this.scrollHeight=1000;this.clientHeight=200;this.top=800;}
  get scrollTop(){return this.top;}
  set scrollTop(value){this.top=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight));}
  userScroll(top){this.scrollTop=top;this.dispatchEvent(new Event('scroll'));}
  input(type,properties){this.dispatchEvent(Object.assign(new Event(type),properties));}
}
function setup(){
  const view=new View(),button=new EventTarget();button.hidden=true;button.classList={toggle:(_name,value)=>{button.hidden=value;}};
  let resize;
  class Resize {constructor(callback){resize=callback;}observe(){}}
  const scroll=new ChatScroll(view,button,{Resize});
  return {view,button,scroll,resize:()=>resize()};
}
test('chat follows large streamed updates only while the reader stays at the bottom',()=>{
  const {view,button,scroll}=setup();scroll.update(()=>{view.scrollHeight+=500;});
  assert.equal(view.scrollTop,1300);assert.equal(button.hidden,true);
  view.userScroll(300);for(let i=0;i<30;i++)scroll.update(()=>{view.scrollHeight+=40;});
  assert.equal(view.scrollTop,300);assert.equal(button.hidden,false);assert.equal(scroll.following,false);
});
test('upward wheel intent pauses before the browser scroll event and small upward scrolls stay paused',()=>{
  const {view,scroll}=setup();view.input('wheel',{deltaY:-1});scroll.update(()=>{view.scrollHeight+=10;});
  assert.equal(view.scrollTop,800);assert.equal(scroll.following,false);
  scroll.jump();view.userScroll(view.scrollTop-1);scroll.update(()=>{view.scrollHeight+=5;});
  assert.equal(view.scrollTop,809);assert.equal(scroll.following,false);
});
test('completion rerenders and nested tool updates preserve the reading position',()=>{
  const {view,scroll}=setup();view.userScroll(250);
  scroll.update(()=>{view.scrollHeight=200;scroll.update(()=>{view.scrollHeight=1600;});});
  assert.equal(view.scrollTop,250);assert.equal(scroll.following,false);
});
test('Jump to latest and scrolling down to the bottom resume following',()=>{
  const {view,button,scroll}=setup();view.userScroll(200);button.dispatchEvent(new Event('click'));
  assert.equal(view.scrollTop,800);assert.equal(button.hidden,true);assert.equal(scroll.following,true);
  view.userScroll(100);view.userScroll(790);assert.equal(scroll.following,true);
  scroll.update(()=>{view.scrollHeight+=100;});assert.equal(view.scrollTop,900);
});
test('switching chats resets following while resizing a paused chat preserves its position',()=>{
  const {view,scroll,resize}=setup();view.userScroll(175);view.clientHeight=150;resize();assert.equal(view.scrollTop,175);
  scroll.reset(()=>{view.scrollHeight=600;});assert.equal(view.scrollTop,450);assert.equal(scroll.following,true);
  view.clientHeight=100;resize();assert.equal(view.scrollTop,500);
});
test('keyboard and touch scrolling pause following without taking focus',()=>{
  const {view,scroll}=setup();view.input('keydown',{key:'Home'});assert.equal(scroll.following,false);
  scroll.jump();view.input('touchstart',{touches:[{clientY:80}]});view.input('touchmove',{touches:[{clientY:120}]});
  scroll.update(()=>{view.scrollHeight+=100;});assert.equal(view.scrollTop,800);assert.equal(scroll.following,false);
});
