export function projectCommand(text) {
  if(typeof text!=='string')return null;
  let candidate=text.trim();
  candidate=candidate.replace(/^(?:please\s+)?(?:open|select|use|switch(?:\s+(?:the\s+)?(?:project|folder))?\s+to|work\s+in)\s+(?:(?:the|this|a)\s+)?(?:(?:project\s+folder|project|folder)\s*(?:at|:)?\s*)?/i,'');
  candidate=candidate.replace(/^```(?:yaml|text|plaintext|powershell)?\s*\r?\n([\s\S]*?)\r?\n```$/i,'$1').trim();
  if((candidate.startsWith('"')&&candidate.endsWith('"')) || (candidate.startsWith("'")&&candidate.endsWith("'")) || (candidate.startsWith('`')&&candidate.endsWith('`'))) candidate=candidate.slice(1,-1).trim();
  // A request with more work is handled by the model's open_project tool.
  if(!/^(?:[a-z]:[\\/]|\\\\)/i.test(candidate) || /[\r\n<>|?*]/.test(candidate) || /\s+(?:and|then)\s+/i.test(candidate))return null;
  return candidate;
}
