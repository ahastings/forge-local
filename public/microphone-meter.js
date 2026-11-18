export function microphoneMeter(stream,onLevel) {
  const Context=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!Context)return ()=>{};
  const context=new Context(),source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();
  analyser.fftSize=512;source.connect(analyser);
  const samples=new Float32Array(analyser.fftSize);let frame,closed=false;
  const tick=()=>{if(closed)return;analyser.getFloatTimeDomainData(samples);let sum=0;for(const sample of samples)sum+=sample*sample;onLevel(Math.min(1,Math.sqrt(sum/samples.length)*5));frame=requestAnimationFrame(tick);};
  void context.resume().catch(()=>{});tick();
  return ()=>{if(closed)return;closed=true;cancelAnimationFrame(frame);source.disconnect();analyser.disconnect();void context.close().catch(()=>{});onLevel(0);};
}
