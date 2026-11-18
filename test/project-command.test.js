import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectCommand } from '../public/project-command.js';
import { userNamedProject } from '../lib/project-intent.js';

test('standalone project commands handle Windows paths, quotes, and pasted code blocks without losing extra tasks',()=>{
  const root='C:\\Projects\\sample-project';
  for(const message of [root,'open '+root,'select folder '+root,'Please select this folder:\n```yaml\n'+root+'\n```','switch project to "'+root+'"','use `'+root+'`'])assert.equal(projectCommand(message),root,message);
  assert.equal(projectCommand('Open "C:\\My Projects\\app"'),'C:\\My Projects\\app');
  assert.equal(projectCommand('open '+root+' and inspect its instructions'),null);
  assert.equal(projectCommand('Please build a website'),null);
});
test('model project switching accepts only a full path named in the user message',()=>{
  assert.equal(userNamedProject('Work in "C:\\Projects\\app" and inspect its instructions.','C:\\Projects\\app'),true);
  assert.equal(userNamedProject('Work in C:/Projects/app','c:\\projects\\app'),true);
  assert.equal(userNamedProject('Continue the last task.','C:\\Projects\\app'),false);
  assert.equal(userNamedProject('Open C:\\Projects\\app\\nested','C:\\Projects\\app'),false);
  assert.equal(userNamedProject('Open C:\\Projects\\app.git','C:\\Projects\\app'),false);
  assert.equal(userNamedProject('Open C:\\Projects\\app','C:\\Projects\\other'),false);
});
