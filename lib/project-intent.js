import path from 'node:path';

// Only user-authored requests can authorize a folder switch, not assistant or tool output.
export function userNamedProject(prompt, requested) {
  if (typeof prompt!=='string' || typeof requested!=='string' || !path.win32.isAbsolute(requested)) return false;
  const normalizedPrompt=prompt.replaceAll('/','\\').toLowerCase();
  const candidate=requested.replaceAll('/','\\').replace(/[\\]+$/,'').toLowerCase();
  if(!candidate || candidate.includes('\0')) return false;
  let from=0;
  while(from<normalizedPrompt.length) {
    const index=normalizedPrompt.indexOf(candidate,from);if(index<0)return false;
    const before=normalizedPrompt[index-1],after=normalizedPrompt[index+candidate.length];
    if((!before || /[\s"'`(\[]/.test(before)) && (!after || /[\s"'`)\],;]/.test(after))) return true;
    from=index+1;
  }
  return false;
}
