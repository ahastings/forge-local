import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DictationDraft} from '../public/voice-input.js';

test('live words replace one draft range and final text is inserted only once',()=>{
  const draft=new DictationDraft();draft.begin('Keep my typed draft.');
  assert.equal(draft.preview('Build').value,'Keep my typed draft. Build');
  assert.equal(draft.preview('Build an app').value,'Keep my typed draft. Build an app');
  assert.equal(draft.finish('Build a small app.').value,'Keep my typed draft. Build a small app.');
  assert.equal(draft.finish('Build a small app.'),null);
});
test('dictation inserts at the caret without deleting surrounding text',()=>{
  const draft=new DictationDraft();draft.begin('Before after',7);
  assert.deepEqual(draft.preview('spoken words'),{value:'Before spoken words after',caret:19});
  assert.deepEqual(draft.preview(''),{value:'Before after',caret:7});
});
test('cancel restores the exact original draft including selected text and whitespace',()=>{
  const draft=new DictationDraft();draft.begin('  Replace this word.\n',10,14);
  assert.equal(draft.preview('new').value,'  Replace new word.\n');
  assert.deepEqual(draft.cancel(),{value:'  Replace this word.\n',caret:10});
  assert.equal(draft.cancel(),null);
});
test('empty transcripts preserve existing drafts and each new recording gets a fresh range',()=>{
  const draft=new DictationDraft();draft.begin('Existing\n');assert.equal(draft.finish('').value,'Existing\n');
  draft.begin('Existing\n');assert.equal(draft.finish('Hello.').value,'Existing\nHello.');
  draft.begin('Existing\nHello.');assert.equal(draft.finish('Next.').value,'Existing\nHello. Next.');
});
