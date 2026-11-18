import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTranscriptionCall,LIVE_TRANSCRIPTION_MODEL} from '../lib/live-transcription.js';
import {TranscriptBuffer,LiveTranscription} from '../public/live-transcription.js';

test('live connection exchanges a short-lived credential server-side and returns only SDP',async()=>{
  let calls=0;
  const result=await createTranscriptionCall({sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111',key:'private-test-key',fetchImpl:async(url,options)=>{
    calls++;
    if(calls===1){assert.match(url,/client_secrets$/);assert.equal(options.headers.Authorization,'Bearer private-test-key');const config=JSON.parse(options.body);assert.equal(config.session.type,'transcription');assert.equal(config.session.audio.input.transcription.model,LIVE_TRANSCRIPTION_MODEL);assert.equal(config.session.audio.input.turn_detection,null);return Response.json({value:'ephemeral-test-secret'});}
    assert.match(url,/realtime\/calls$/);assert.equal(options.headers.Authorization,'Bearer ephemeral-test-secret');assert.equal(options.headers['Content-Type'],'application/sdp');return new Response('v=0\r\nm=audio 9 accepted');
  }});
  assert.deepEqual(result,{sdp:'v=0\r\nm=audio 9 accepted',model:LIVE_TRANSCRIPTION_MODEL});assert.doesNotMatch(JSON.stringify(result),/secret|key/);assert.equal(calls,2);
  await assert.rejects(createTranscriptionCall({sdp:'invalid',key:'test',fetchImpl:()=>assert.fail('no request for invalid SDP')}),/valid microphone SDP/);
  await assert.rejects(createTranscriptionCall({sdp:'v=0\nm=audio',key:'test',fetchImpl:async()=>Response.json({},{status:403})}),/HTTP 403/);
});

test('live transcript previews merge deltas and replace finals without duplication or turn reordering',()=>{
  const buffer=new TranscriptBuffer();
  buffer.accept({type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'Build '});assert.equal(buffer.text,'Build');
  buffer.accept({type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'a dashboard'});assert.equal(buffer.text,'Build a dashboard');
  buffer.accept({type:'input_audio_buffer.committed',item_id:'b',previous_item_id:'a'});
  buffer.accept({type:'conversation.item.input_audio_transcription.completed',item_id:'b',transcript:'Then test it.'});
  buffer.accept({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'Build a dashboard.'});
  buffer.accept({type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:' duplicate'});
  assert.equal(buffer.text,'Build a dashboard. Then test it.');
});

class Channel extends EventTarget {
  constructor(){super();this.readyState='connecting';this.sent=[];}
  send(value){this.sent.push(JSON.parse(value));if(JSON.parse(value).type==='input_audio_buffer.commit')queueMicrotask(()=>this.message({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'Live words.'}));}
  message(data){const event=new Event('message');event.data=JSON.stringify(data);this.dispatchEvent(event);}
  close(){this.readyState='closed';this.dispatchEvent(new Event('close'));}
}
class Peer extends EventTarget {
  addTrack(){}
  createDataChannel(){return this.channel=new Channel();}
  async createOffer(){return {type:'offer',sdp:'v=0\nm=audio'};}
  async setLocalDescription(){}
  async setRemoteDescription(){this.channel.readyState='open';this.channel.dispatchEvent(new Event('open'));}
  close(){this.connectionState='closed';}
}
test('live words arrive while the connection is open and stop drains the final transcript',async()=>{
  const preview=[];
  const live=new LiveTranscription({Peer,fetchImpl:async function(){assert.equal(this,globalThis,'browser fetch needs its global receiver');return Response.json({sdp:'v=0\nanswer'});},onPreview:text=>preview.push(text)});
  await live.start({getAudioTracks:()=>[{}]},new AbortController().signal);
  live.channel.message({type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'Live '});
  live.channel.message({type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'words'});
  assert.equal(live.available,true);assert.equal(preview.at(-1),'Live words');
  assert.deepEqual(await live.finish(),{text:'Live words.'});assert.equal(live.closed,true);
});

test('cancelling a live connection blocks late preview events and closes its peer',async()=>{
  const preview=[],controller=new AbortController();
  const live=new LiveTranscription({Peer,fetchImpl:async()=>Response.json({sdp:'v=0'}),onPreview:text=>preview.push(text)});
  await live.start({getAudioTracks:()=>[{}]},controller.signal);controller.abort();
  live.channel.message({type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'Late words'});
  assert.equal(live.peer.connectionState,'closed');assert.deepEqual(preview,[]);
});
