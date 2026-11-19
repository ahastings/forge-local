export class ChatScroll {
  constructor(view,button,{Resize=globalThis.ResizeObserver,threshold=24}={}) {
    Object.assign(this,{view,button,threshold});this.following=true;this.lastTop=view.scrollTop;this.depth=0;
    view.addEventListener('scroll',()=>{
      const top=view.scrollTop,delta=top-this.lastTop;
      if(delta<0)this.following=false;
      else if(delta>0&&this.atBottom(this.threshold))this.following=true;
      this.lastTop=top;this.showButton();
    },{passive:true});
    // Pause before the next streamed word, including the frame before scroll fires.
    view.addEventListener('wheel',event=>{if(event.deltaY<0)this.pause();},{passive:true});
    view.addEventListener('keydown',event=>{if(['ArrowUp','PageUp','Home'].includes(event.key))this.pause();});
    view.addEventListener('touchstart',event=>{this.touchY=event.touches[0]?.clientY;},{passive:true});
    view.addEventListener('touchmove',event=>{const y=event.touches[0]?.clientY;if(y>this.touchY)this.pause();this.touchY=y;},{passive:true});
    button.addEventListener('click',()=>this.jump());
    if(Resize){this.resize=new Resize(()=>this.update(()=>{}));this.resize.observe(view);}
    this.showButton();
  }
  atBottom(tolerance=2){return this.view.scrollHeight-this.view.clientHeight-this.view.scrollTop<=tolerance;}
  showButton(){this.button.classList.toggle('hidden',this.following||this.atBottom());}
  pause(){this.following=false;this.lastTop=this.view.scrollTop;this.showButton();}
  jump(){this.following=true;this.view.scrollTop=this.view.scrollHeight;this.lastTop=this.view.scrollTop;this.showButton();}
  update(change) {
    const outer=this.depth===0;if(outer)this.savedTop=this.view.scrollTop;
    this.depth++;
    try{return change();}
    finally{
      this.depth--;
      if(outer){this.view.scrollTop=this.following?this.view.scrollHeight:this.savedTop;this.lastTop=this.view.scrollTop;this.showButton();}
    }
  }
  reset(change){this.following=true;return this.update(change);}
}
