export const MAX_AUDIO_BYTES = 5_000_000;
export const TRANSCRIPTION_MODEL = 'gpt-transcribe';
const formats = new Map([['audio/webm','webm'],['audio/mp4','mp4'],['audio/ogg','ogg'],['audio/wav','wav']]);

export function audioFormat(contentType = '') {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const extension = formats.get(mime);
  if (!extension) throw new Error('Unsupported recording format. Use a current Chrome or Edge browser.');
  return {mime,extension};
}

export async function readAudio(request) {
  const format = audioFormat(request.headers['content-type']);
  if (Number(request.headers['content-length']) > MAX_AUDIO_BYTES) throw new Error('Recording exceeds 5 MB. Record a shorter message.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_AUDIO_BYTES) throw new Error('Recording exceeds 5 MB. Record a shorter message.');
    chunks.push(chunk);
  }
  if (!size) throw new Error('No microphone audio was received.');
  return {audio:Buffer.concat(chunks),...format};
}

export async function transcribeAudio({audio,mime,extension,key,signal,fetchImpl=fetch}) {
  if (!key) throw new Error('Connect an OpenAI API key in Settings to use dictation.');
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new Error('Recording must contain audio and be at most 5 MB.');
  const form = new FormData();
  form.append('model',TRANSCRIPTION_MODEL);
  form.append('file',new Blob([audio],{type:mime}),'dictation.'+extension);
  const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{
    method:'POST',headers:{Authorization:'Bearer '+key},body:form,signal
  });
  const result = await response.json().catch(()=>({}));
  if (!response.ok) {
    if (response.status===401) throw new Error('OpenAI rejected the saved API key. Check Settings and your API account.');
    if (response.status===429) throw new Error('OpenAI dictation quota or rate limit reached. Check your API balance and try again later.');
    if (response.status===403 || response.status===404) throw new Error('This API project cannot access '+TRANSCRIPTION_MODEL+'. Check model permissions in your OpenAI account.');
    throw new Error('OpenAI could not transcribe this recording (HTTP '+response.status+'). Try a shorter recording.');
  }
  if (typeof result.text!=='string') throw new Error('OpenAI returned no transcript. Try recording again.');
  return {text:result.text.trim(),model:TRANSCRIPTION_MODEL};
}
