export class TranscriptBuffer {
  constructor(){this.items=new Map();}
  accept(event) {
    if(!event.item_id)return false;
    const item=this.items.get(event.item_id)||{text:'',previous:undefined,complete:false};
    if(event.type==='input_audio_buffer.committed')item.previous=event.previous_item_id;
    else if(event.type==='conversation.item.input_audio_transcription.delta'){if(!item.complete)item.text+=event.delta||'';}
    else if(event.type==='conversation.item.input_audio_transcription.completed'){item.text=event.transcript||'';item.complete=true;}
    else return false;
    this.items.set(event.item_id,item);return true;
  }
  get text(){
    const entries=[...this.items.entries()],ordered=[],seen=new Set();
    const add=([id,item])=>{if(seen.has(id))return;seen.add(id);if(item.previous&&this.items.has(item.previous))add([item.previous,this.items.get(item.previous)]);ordered.push(item.text.trim());};
    entries.forEach(add);return ordered.filter(Boolean).join(' ');
  }
}

export class LiveTranscription {
  constructor({onPreview=()=>{},onUnavailable=()=>{},Peer=globalThis.RTCPeerConnection,fetchImpl=fetch}={}) {
    Object.assign(this,{onPreview,onUnavailable,Peer});this.fetchImpl=fetchImpl.bind(globalThis);this.buffer=new TranscriptBuffer();this.available=false;this.closed=false;
  }
  async start(stream,signal) {
    if(!this.Peer)throw new Error('This browser does not support live audio.');
    this.requestController=new AbortController();
    this.signal=signal;this.abort=()=>this.close();signal.addEventListener('abort',this.abort,{once:true});signal.throwIfAborted();
    const peer=this.peer=new this.Peer();
    for(const track of stream.getAudioTracks())peer.addTrack(track,stream);
    const channel=this.channel=peer.createDataChannel('oai-events');
    channel.addEventListener('message',event=>{
      if(this.closed)return;
      let data;try{data=JSON.parse(event.data);}catch{return;}
      if(data.type==='error'||data.type==='conversation.item.input_audio_transcription.failed') {
        this.available=false;this.rejectFinal?.(new Error('Live transcription failed.'));this.onUnavailable();return;
      }
      if(this.buffer.accept(data))this.onPreview(this.buffer.text);
      if(data.type==='conversation.item.input_audio_transcription.completed'&&this.finishing)this.resolveFinal?.({text:this.buffer.text});
    });
    peer.addEventListener('connectionstatechange',()=>{if(['failed','closed'].includes(peer.connectionState)&&!this.closed){this.available=false;this.rejectFinal?.(new Error('Live audio disconnected.'));this.onUnavailable();}});
    let openResolve,openReject;
    const opened=new Promise((resolve,reject)=>{openResolve=resolve;openReject=reject;});
    // Attach a handler before negotiation, since cancellation can happen first.
    opened.catch(()=>{});this.rejectOpen=openReject;
    channel.addEventListener('open',()=>{this.available=true;openResolve();},{once:true});
    channel.addEventListener('close',()=>{if(!this.closed){this.available=false;openReject(new Error('Live audio disconnected.'));this.rejectFinal?.(new Error('Live audio disconnected.'));this.onUnavailable();}});
    const timer=setTimeout(()=>openReject(new Error('Live audio connection timed out.')),15_000);
    try {
      const negotiation=(async()=>{
        const offer=await peer.createOffer();await peer.setLocalDescription(offer);
        const response=await this.fetchImpl('/api/voice-session',{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Request':'1'},body:JSON.stringify({sdp:offer.sdp}),signal:this.requestController.signal});
        const answer=await response.json();if(!response.ok)throw new Error(answer.error||'Live transcription is unavailable.');
        signal.throwIfAborted();if(this.closed)throw new Error('Live audio cancelled.');
        await peer.setRemoteDescription({type:'answer',sdp:answer.sdp});
        await opened;
      })();
      await Promise.race([negotiation,opened.then(()=>new Promise(()=>{}))]);
    } finally {clearTimeout(timer);this.rejectOpen=null;}
  }
  async finish() {
    if(!this.available||this.closed)throw new Error('Live transcript unavailable.');
    this.finishing=true;
    const result=new Promise((resolve,reject)=>{this.resolveFinal=resolve;this.rejectFinal=reject;});
    const timeout=setTimeout(()=>this.rejectFinal?.(new Error('Live transcript finalization timed out.')),10_000);
    // Let the final RTP packets arrive after the microphone has stopped.
    const commit=setTimeout(()=>{if(!this.closed&&this.channel.readyState==='open')this.channel.send(JSON.stringify({type:'input_audio_buffer.commit'}));},250);
    try{return await result;}finally{clearTimeout(timeout);clearTimeout(commit);this.close();}
  }
  close() {
    if(this.closed)return;this.closed=true;this.available=false;
    this.requestController?.abort();
    this.rejectOpen?.(new Error('Live audio cancelled.'));this.rejectFinal?.(new Error('Live audio cancelled.'));
    this.channel?.close();this.peer?.close();this.signal?.removeEventListener('abort',this.abort);
  }
}
