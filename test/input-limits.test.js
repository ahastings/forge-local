import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptText } from '../public/input-limits.js';

test('chat accepts 32,000 and exactly 40,000 characters and rejects larger or empty input',()=>{
  for(const length of [32_000,40_000]){const input='x'.repeat(length);assert.equal(promptText(input),input);}
  assert.equal(promptText('  Keep this task.  '),'Keep this task.');
  assert.throws(()=>promptText('x'.repeat(40_001)),/40,000 characters.*40,001/);
  assert.throws(()=>promptText(' \n '),/Enter a task/);
});
