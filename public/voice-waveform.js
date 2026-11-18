export class VoiceWaveform {
  constructor(canvas){this.canvas=canvas;this.context=canvas.getContext('2d');this.levels=new Float32Array(40);this.lastFrame=0;this.reset();}
  reset(){this.levels.fill(0);this.lastFrame=0;this.draw();}
  push(level){
    const now=performance.now();if(now-this.lastFrame<45)return;this.lastFrame=now;
    this.levels.copyWithin(0,1);this.levels[this.levels.length-1]=Math.max(0,Math.min(1,level));this.draw();
  }
  draw(){
    const ctx=this.context;if(!ctx)return;
    const width=this.canvas.width,height=this.canvas.height;ctx.clearRect(0,0,width,height);ctx.lineWidth=2;ctx.lineCap='round';
    for(let i=0;i<this.levels.length;i++){
      const x=2+i*(width-4)/(this.levels.length-1),half=1+this.levels[i]*(height/2-3);
      ctx.strokeStyle=`rgba(185,245,187,${.22+.78*i/(this.levels.length-1)})`;
      ctx.beginPath();ctx.moveTo(x,height/2-half);ctx.lineTo(x,height/2+half);ctx.stroke();
    }
  }
}
