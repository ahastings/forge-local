const MAX_BYTES = 5_000_000;
const MAX_SECONDS = 120;
const STOP_TIMEOUT_MS = 4000;
const TRANSCRIBE_TIMEOUT_MS = 45000;

export function microphoneError(error) {
  if (error.name==='NotAllowedError' || error.name==='SecurityError') return 'Microphone access is blocked. Allow it in your browser’s site permissions, or open this app in Chrome or Edge.';
  if (error.name==='NotFoundError') return 'No microphone was found. Connect one and select it as your Windows default input.';
  if (error.name==='NotReadableError') return 'Your microphone is unavailable. Check Windows microphone permissions and whether another app is using it.';
  return error.message || 'Dictation failed. Try recording again.';
}

// The microphone opens only after start(), which the UI calls from a user click.
export class VoiceInput {
  constructor({mediaDevices=globalThis.navigator?.mediaDevices,Recorder=globalThis.MediaRecorder,
    transcribe,onText,onState=()=>{},onError=()=>{},createLive,monitor,onPreview=()=>{},onLevel=()=>{},onLiveStatus=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}={}) {
    Object.assign(this,{mediaDevices,Recorder,transcribe,onText,onState,onError,createLive,monitor,onPreview,onLevel,onLiveStatus});
    // Browser timers require Window as their receiver. Calling an unbound native
    // timer as this.setTimer()/this.clearTimer() throws "Illegal invocation".
    this.setTimer=setTimer.bind(globalThis);this.clearTimer=clearTimer.bind(globalThis);
    this.phase='idle';this.capture=null;
  }
  get supported() {return !!(this.mediaDevices?.getUserMedia && this.Recorder);}
  get active() {return this.phase!=='idle';}
  update(phase,detail={}) {this.phase=phase;this.onState({phase,...detail});}
  release(capture) {
    capture.stopMeter?.();capture.stopMeter=null;
    capture.stream?.getTracks().forEach(track=>track.stop());
    this.clearTimer(capture.timer);this.clearTimer(capture.stopTimer);
  }
  async start() {
    if (this.active) return;
    if (!this.supported) {this.onError('Microphone recording is unavailable here. Open http://127.0.0.1:4317 in a current Chrome or Edge browser.');return;}
    const capture={controller:new AbortController(),chunks:[],size:0,cancelled:false};
    this.capture=capture;this.update('requesting');
    this.onPreview('');this.onLevel(0);this.onLiveStatus('');
    try {
      // No device ID selects the system/browser default input microphone.
      capture.stream=await this.mediaDevices.getUserMedia({audio:true});
      if(capture.cancelled) {this.release(capture);return;}
      try{capture.stopMeter=this.monitor?.(capture.stream,level=>{if(!capture.cancelled&&this.capture===capture)this.onLevel(level);});}catch{}
      if(this.createLive) {
        this.update('connecting');this.onLiveStatus('Connecting live text…');
        try {
          capture.live=this.createLive({onPreview:text=>{if(!capture.cancelled&&this.capture===capture)this.onPreview(text);},onUnavailable:()=>{if(!capture.cancelled&&this.capture===capture)this.onLiveStatus('Live text unavailable · Text will appear after stopping.');}});
          await capture.live.start(capture.stream,capture.controller.signal);
          this.onLiveStatus('Live text · OpenAI');
        } catch(error) {
          capture.live?.close();capture.live=null;
          if(!capture.cancelled)this.onLiveStatus('Live text unavailable: '+microphoneError(error)+' Text will appear after stopping.');
        }
        if(capture.cancelled){this.release(capture);return;}
      }
      const mimeType=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'].find(type=>this.Recorder.isTypeSupported(type));
      if(!mimeType) throw new Error('This browser cannot record a supported audio format. Open this app in Chrome or Edge.');
      const recorder=capture.recorder=new this.Recorder(capture.stream,{mimeType,audioBitsPerSecond:64000});
      recorder.addEventListener('dataavailable',event=>{
        if(capture.cancelled||!event.data.size)return;
        capture.size+=event.data.size;
        if(capture.size>MAX_BYTES) {this.fail(capture,new Error('Recording exceeds 5 MB. Record a shorter message.'));return;}
        capture.chunks.push(event.data);
      });
      recorder.addEventListener('error',event=>this.fail(capture,event.error||new Error('The microphone stopped unexpectedly.')));
      recorder.addEventListener('stop',()=>void this.finish(capture));
      for(const track of capture.stream.getAudioTracks()) track.addEventListener('ended',()=>{if(this.capture===capture&&this.phase==='recording'&&!capture.finalizing)this.stop();});
      recorder.start(1000);this.update('recording',{seconds:0});
      let seconds=0;
      const tick=()=>{if(this.capture!==capture||this.phase!=='recording')return;seconds++;this.update('recording',{seconds});if(seconds>=MAX_SECONDS)this.stop();else capture.timer=this.setTimer(tick,1000);};
      capture.timer=this.setTimer(tick,1000);
    } catch(error) {this.fail(capture,error);}
  }
  stop() {
    const capture=this.capture;
    if(!capture || this.phase!=='recording')return;
    this.update('stopping');this.clearTimer(capture.timer);
    // Keep the stream alive until dataavailable/stop delivers the final audio.
    // Some embedded browsers miss stop; use the chunks already delivered in that case.
    capture.stopTimer=this.setTimer(()=>void this.finish(capture),STOP_TIMEOUT_MS);
    try {capture.recorder.stop();} catch(error) {this.fail(capture,error);}
  }
  async finish(capture) {
    if(capture.cancelled||this.capture!==capture||capture.finalizing)return;
    capture.finalizing=true;
    this.release(capture);
    try {
      if(!capture.size)throw new Error('No audio was recorded. Check your default microphone and try again.');
      const audio=new Blob(capture.chunks,{type:capture.recorder.mimeType});
      capture.chunks=[];this.update('transcribing');
      const deadline=new Promise((_,reject)=>{
        capture.rejectWaiting=reject;
        capture.uploadTimer=this.setTimer(()=>reject(new Error('Transcription took too long. Please try a shorter recording.')),TRANSCRIBE_TIMEOUT_MS);
      });
      const result=await Promise.race([deadline,Promise.resolve().then(()=>{
        capture.controller.signal.throwIfAborted();
        if(capture.live?.available)return capture.live.finish().catch(()=>{capture.controller.signal.throwIfAborted();return this.transcribe(audio,capture.controller.signal);});
        return this.transcribe(audio,capture.controller.signal);
      })]);
      if(capture.cancelled||this.capture!==capture)return;
      this.capture=null;this.update('idle',{complete:true});
      if(result.text?.trim())this.onText(result.text.trim());
      else this.onError('No speech was detected. Try speaking closer to your microphone.');
    } catch(error) {this.fail(capture,error);}
    finally {this.clearTimer(capture.uploadTimer);capture.rejectWaiting=null;capture.live?.close();}
  }
  cancel() {
    const capture=this.capture;if(!capture)return;
    capture.cancelled=true;capture.controller.abort();capture.chunks=[];
    capture.live?.close();this.onPreview('');this.onLiveStatus('');
    capture.rejectWaiting?.(new Error('Dictation cancelled.'));this.clearTimer(capture.uploadTimer);
    try {if(capture.recorder?.state==='recording')capture.recorder.stop();}catch{}
    this.release(capture);this.capture=null;this.update('idle',{cancelled:true});
  }
  fail(capture,error) {
    if(capture.cancelled||this.capture!==capture)return;
    this.cancel();this.onError(microphoneError(error));
  }
}

export function appendTranscript(draft,text) {
  const transcript=text.trim();
  return transcript ? draft+(draft&&!/\s$/.test(draft)?' ':'')+transcript : draft;
}

// One replacement range prevents interim/final transcripts from duplicating words.
export class DictationDraft {
  begin(value,start=value.length,end=start) {
    this.original=value;this.start=Math.max(0,Math.min(start,value.length));
    this.before=value.slice(0,this.start);this.after=value.slice(Math.max(this.start,Math.min(end,value.length)));this.active=true;
  }
  preview(text) {
    if(!this.active)return null;
    const spoken=text.trim();if(!spoken)return {value:this.original,caret:this.start};
    const prefix=this.before+(this.before&&!/\s$/.test(this.before)?' ':'');
    const suffix=(this.after&&!/^\s/.test(this.after)?' ':'')+this.after;
    return {value:prefix+spoken+suffix,caret:prefix.length+spoken.length};
  }
  finish(text) {const result=this.preview(text);this.active=false;return result;}
  cancel() {if(!this.active)return null;this.active=false;return {value:this.original,caret:this.start};}
}
