import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { VoiceInput, appendTranscript } from '../public/voice-input.js';
import { audioFormat, readAudio, transcribeAudio, MAX_AUDIO_BYTES, TRANSCRIPTION_MODEL } from '../lib/transcription.js';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
class Recorder extends EventTarget {
  static isTypeSupported(type){return type==='audio/webm;codecs=opus';}
  constructor(stream,{mimeType}){super();this.mimeType=mimeType;this.state='inactive';}
  start(){this.state='recording';}
  stop(){this.state='inactive';queueMicrotask(()=>{const data=new Event('dataavailable');data.data=new Blob(['test audio'],{type:this.mimeType});this.dispatchEvent(data);this.dispatchEvent(new Event('stop'));});}
}
function setup(options={}) {
  const track=new EventTarget();track.stops=0;track.stop=()=>track.stops++;
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const states=[],errors=[],texts=[],requests=[];
  const voice=new VoiceInput({Recorder,mediaDevices:{getUserMedia:async constraints=>{requests.push(constraints);return stream;}},
    transcribe:async audio=>{assert.equal(audio.type,'audio/webm;codecs=opus');return{text:'Build a local dashboard.'};},
    onState:state=>states.push(state),onError:text=>errors.push(text),onText:text=>texts.push(text),...options});
  return {voice,track,stream,states,errors,texts,requests};
}

test('dictation uses the default microphone, releases it before upload and only returns draft text',async()=>{
  const context=setup({transcribe:async audio=>{assert.ok(context.track.stops>0);assert.equal(await audio.text(),'test audio');return{text:'Build a local dashboard.'};}});
  assert.equal(context.requests.length,0);await context.voice.start();await context.voice.start();
  assert.deepEqual(context.requests,[{audio:true}]);assert.equal(context.voice.phase,'recording');
  context.voice.stop();assert.equal(context.track.stops,0,'do not close the stream before final recorder data');
  await flush();assert.equal(context.voice.phase,'idle');assert.deepEqual(context.texts,['Build a local dashboard.']);assert.deepEqual(context.errors,[]);
  assert.equal(appendTranscript('Existing typed draft','Speak this.'),'Existing typed draft Speak this.');
  assert.equal(appendTranscript('Draft\n',' New words '),'Draft\nNew words');
  assert.equal(appendTranscript('','Voice message'),'Voice message');
});

test('native browser timers retain their global receiver during recording and cleanup',async()=>{
  let scheduled=0,cleared=0;
  const context=setup({
    setTimer:function(){assert.equal(this,globalThis,'browser setTimeout requires its global receiver');return ++scheduled;},
    clearTimer:function(){assert.equal(this,globalThis,'browser clearTimeout requires its global receiver');cleared++;}
  });
  await context.voice.start();assert.equal(context.voice.phase,'recording');context.voice.stop();await flush();
  assert.deepEqual(context.errors,[]);assert.equal(context.voice.phase,'idle');assert.ok(scheduled>0);assert.ok(cleared>0);assert.equal(context.texts.length,1);
});

test('live dictation previews words during recording, finalizes once, and does not duplicate draft text',async()=>{
  let callbacks;const preview=[];let closes=0;
  const context=setup({createLive:options=>{callbacks=options;return {available:true,start:async()=>{},finish:async()=>({text:'Live transcript.'}),close:()=>closes++};},onPreview:text=>preview.push(text),transcribe:()=>assert.fail('healthy live session should not upload the backup')});
  await context.voice.start();callbacks.onPreview('Live tran');assert.equal(context.voice.phase,'recording');assert.equal(preview.at(-1),'Live tran');assert.deepEqual(context.texts,[]);
  context.voice.stop();await flush();assert.deepEqual(context.texts,['Live transcript.']);assert.equal(context.voice.phase,'idle');assert.ok(closes>0);
});

test('unavailable live service falls back to the existing recorded-audio transcription',async()=>{
  const notices=[];
  const context=setup({createLive:()=>({available:false,start:async()=>{throw new Error('live denied');},close:()=>{}}),onLiveStatus:text=>notices.push(text)});
  await context.voice.start();assert.equal(context.voice.phase,'recording');assert.match(notices.at(-1),/after stopping/);context.voice.stop();await flush();assert.deepEqual(context.texts,['Build a local dashboard.']);
});

test('cancelling while permission is pending releases a late stream without recording or uploading',async()=>{
  let allow;const context=setup({mediaDevices:{getUserMedia:()=>new Promise(resolve=>{allow=resolve;})},transcribe:()=>assert.fail('must not upload')});
  const pending=context.voice.start();assert.equal(context.voice.phase,'requesting');context.voice.cancel();
  allow(context.stream);await pending;assert.equal(context.voice.phase,'idle');assert.ok(context.track.stops>0);assert.deepEqual(context.texts,[]);
});

test('cancelled recordings and in-flight transcripts never insert text into another chat',async()=>{
  const recording=setup({transcribe:()=>assert.fail('cancelled recording must not upload')});await recording.voice.start();recording.voice.cancel();await flush();assert.deepEqual(recording.texts,[]);
  let resolveUpload,uploadSignal;
  const context=setup({transcribe:(_audio,signal)=>{uploadSignal=signal;return new Promise(resolve=>{resolveUpload=resolve;});}});
  await context.voice.start();context.voice.stop();await flush();assert.equal(context.voice.phase,'transcribing');context.voice.cancel();
  assert.ok(uploadSignal.aborted);resolveUpload({text:'This must not enter the next chat.'});await flush();assert.deepEqual(context.texts,[]);assert.equal(context.voice.phase,'idle');
});

test('dictation stops at two minutes and microphone permission failures produce useful messages',async()=>{
  let tick;
  const context=setup({setTimer:fn=>{tick=fn;return 1;},clearTimer:()=>{}});
  await context.voice.start();for(let i=0;i<120;i++)tick();await flush();
  assert.equal(context.states.filter(state=>state.phase==='recording').at(-1).seconds,120);assert.equal(context.voice.phase,'idle');assert.equal(context.texts.length,1);
  const denied=setup({mediaDevices:{getUserMedia:async()=>{const error=new Error('denied');error.name='NotAllowedError';throw error;}}});
  await denied.voice.start();assert.equal(denied.voice.phase,'idle');assert.match(denied.errors[0],/site permissions/);
  const unavailable=setup({Recorder:null});await unavailable.voice.start();assert.match(unavailable.errors[0],/Chrome or Edge/);
});

test('a missing recorder stop event uses the delivered audio once and releases the microphone',async()=>{
  let recover,uploads=0;
  class MissingStop extends Recorder {
    stop(){this.state='inactive';const event=new Event('dataavailable');event.data=new Blob(['final audio'],{type:this.mimeType});this.dispatchEvent(event);}
  }
  const context=setup({Recorder:MissingStop,setTimer:fn=>{recover=fn;return 1;},clearTimer:()=>{},transcribe:async audio=>{uploads++;assert.equal(await audio.text(),'final audio');return{text:'Recovered speech.'};}});
  await context.voice.start();context.voice.stop();assert.equal(context.voice.phase,'stopping');
  recover();await flush();assert.equal(context.voice.phase,'idle');assert.deepEqual(context.texts,['Recovered speech.']);assert.ok(context.track.stops>0);
  context.voice.finish(context.voice.capture||{cancelled:true});await flush();assert.equal(uploads,1);
});

test('a stalled transcript times out, resets the controls and ignores a late response',async()=>{
  let deadline,resolveUpload,signal;
  const context=setup({setTimer:(fn,ms)=>{if(ms===45000)deadline=fn;return ms;},clearTimer:()=>{},transcribe:(_audio,requestSignal)=>{signal=requestSignal;return new Promise(resolve=>{resolveUpload=resolve;});}});
  await context.voice.start();context.voice.stop();await flush();assert.equal(context.voice.phase,'transcribing');
  deadline();await flush();assert.equal(context.voice.phase,'idle');assert.ok(signal.aborted);assert.match(context.errors[0],/took too long/);
  resolveUpload({text:'Late text must be ignored.'});await flush();assert.deepEqual(context.texts,[]);
});

test('failed transcription and missing final audio leave dictation idle with a visible error',async()=>{
  const failed=setup({transcribe:async()=>{throw new Error('OpenAI unavailable.');}});await failed.voice.start();failed.voice.stop();await flush();
  assert.equal(failed.voice.phase,'idle');assert.deepEqual(failed.errors,['OpenAI unavailable.']);assert.ok(failed.track.stops>0);
  let timeout;
  class NoEvents extends Recorder {stop(){this.state='inactive';}}
  const empty=setup({Recorder:NoEvents,setTimer:fn=>{timeout=fn;return 1;},clearTimer:()=>{},transcribe:()=>assert.fail('must not upload empty audio')});
  await empty.voice.start();empty.voice.stop();timeout();await flush();assert.equal(empty.voice.phase,'idle');assert.match(empty.errors[0],/No audio was recorded/);
});

test('audio upload validates media types, size and empty recordings before any provider request',async()=>{
  assert.deepEqual(audioFormat('audio/webm;codecs=opus'),{mime:'audio/webm',extension:'webm'});assert.throws(()=>audioFormat('text/html'),/Unsupported/);
  const request=(chunks,headers)=>Object.assign(Readable.from(chunks),{headers});
  const valid=await readAudio(request([Buffer.from('audio')],{'content-type':'audio/mp4'}));assert.equal(valid.extension,'mp4');assert.equal(valid.audio.toString(),'audio');
  await assert.rejects(readAudio(request([],{'content-type':'audio/webm'})),/No microphone audio/);
  await assert.rejects(readAudio(request([],{'content-type':'audio/webm','content-length':String(MAX_AUDIO_BYTES+1)})),/exceeds 5 MB/);
  await assert.rejects(readAudio(request([Buffer.alloc(MAX_AUDIO_BYTES),Buffer.from('x')],{'content-type':'audio/webm'})),/exceeds 5 MB/);
});

test('OpenAI transcription sends multipart audio server-side and handles quota and malformed responses',async()=>{
  const options={audio:Buffer.from('mock audio'),mime:'audio/webm',extension:'webm',key:'fake-private-key',signal:new AbortController().signal};
  const result=await transcribeAudio({...options,fetchImpl:async(url,request)=>{
    assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');assert.equal(request.headers.Authorization,'Bearer fake-private-key');assert.equal(request.signal,options.signal);
    assert.equal(request.body.get('model'),TRANSCRIPTION_MODEL);assert.equal(request.body.get('file').name,'dictation.webm');assert.equal(await request.body.get('file').text(),'mock audio');
    return Response.json({text:'  Make the feature.  '});
  }});
  assert.deepEqual(result,{text:'Make the feature.',model:TRANSCRIPTION_MODEL});
  await assert.rejects(transcribeAudio({...options,fetchImpl:async()=>Response.json({error:{message:'sensitive upstream text'}},{status:429})}),/quota or rate limit/);
  await assert.rejects(transcribeAudio({...options,fetchImpl:async()=>Response.json({})}),/no transcript/);
  await assert.rejects(transcribeAudio({...options,key:'',fetchImpl:()=>assert.fail('no key must not call API')}),/API key/);
});
