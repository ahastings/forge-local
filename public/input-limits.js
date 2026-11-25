export const MAX_PROMPT_CHARS = 40_000;
export const MAX_COMMAND_CHARS = 20_000;

export function promptText(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('Enter a task.');
  if (text.length > MAX_PROMPT_CHARS) throw new Error(`Chat messages can contain up to ${MAX_PROMPT_CHARS.toLocaleString('en-US')} characters (you entered ${text.length.toLocaleString('en-US')}).`);
  return text;
}
