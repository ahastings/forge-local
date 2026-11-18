export const LIVE_TRANSCRIPTION_MODEL='gpt-live-transcribe';

export async function createTranscriptionCall({sdp,key,signal,fetchImpl=fetch}) {
  if(!key)throw new Error('Connect an OpenAI API key in Settings to use live dictation.');
  if(typeof sdp!=='string'||sdp.length>65_536||!sdp.startsWith('v=0')||!sdp.includes('m=audio'))throw new Error('A valid microphone SDP offer is required.');
  const secretResponse=await fetchImpl('https://api.openai.com/v1/realtime/client_secrets',{
    method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},signal,
    body:JSON.stringify({expires_after:{anchor:'created_at',seconds:60},session:{type:'transcription',audio:{input:{transcription:{model:LIVE_TRANSCRIPTION_MODEL},turn_detection:null}}}})
  });
  if(!secretResponse.ok)throw new Error('Live transcription is unavailable for this API project (HTTP '+secretResponse.status+'). Recording can still be transcribed after stopping.');
  const secret=await secretResponse.json();
  if(typeof secret.value!=='string'||!secret.value)throw new Error('OpenAI did not create a live transcription session.');
  // The short-lived credential is consumed here, never returned to the browser.
  const answer=await fetchImpl('https://api.openai.com/v1/realtime/calls',{
    method:'POST',headers:{Authorization:'Bearer '+secret.value,'Content-Type':'application/sdp'},body:sdp,signal
  });
  if(!answer.ok)throw new Error('Live audio connection failed (HTTP '+answer.status+'). Recording can still be transcribed after stopping.');
  const result=await answer.text();
  if(!result.startsWith('v=0'))throw new Error('OpenAI returned an invalid audio connection.');
  return {sdp:result,model:LIVE_TRANSCRIPTION_MODEL};
}
