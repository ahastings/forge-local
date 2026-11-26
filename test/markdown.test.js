import {test} from 'node:test';
import assert from 'node:assert/strict';
import {markdown,parseMarkdown} from '../public/markdown.js';

class Node {
  constructor(document,tag='#text',text=''){this.ownerDocument=document;this.tag=tag;this.children=[];this.text=text;this.attributes={};this.style={setProperty:(key,value)=>{this.style[key]=value;}};}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.text='';this.children=nodes;}
  setAttribute(key,value){this.attributes[key]=value;}
  set textContent(value){this.text=value;this.children=[];}
  get textContent(){return this.text+this.children.map(node=>node.textContent).join('');}
}
function render(text){const document={createElement:tag=>new Node(document,tag),createTextNode:text=>new Node(document,'#text',text)};const root=new Node(document,'div');markdown(root,text);return root;}
function elements(root,tag){return [...(root.tag===tag?[root]:[]),...root.children.flatMap(node=>elements(node,tag))];}
const sample='| Priority | Capital allocation | Potential payoff | Downside / catch | My take |\n|---|---|---|---|---|\n| **1** | **Build a template** | Reusable code | Requires testing | Start small |\n| **2** | Review | Find issues | Takes time | Verify results |';

test('five-column replies render semantic tables with formatted cells and a scrollable wrapper',()=>{
  const root=render(sample);
  assert.equal(elements(root,'table').length,1);assert.equal(elements(root,'th').length,5);assert.equal(elements(root,'td').length,10);
  assert.equal(elements(root,'th')[0].attributes.scope,'col');assert.equal(elements(root,'strong')[1].textContent,'Build a template');
  assert.equal(root.children[0].attributes['aria-label'],'Scrollable table');assert.equal(root.children[0].tabIndex,0);
});
test('tables without outer pipes preserve alignment and normalize missing or extra cells',()=>{
  const source='Name | Value | Note\n:--- | :---: | ---:\nAlpha | 10\nBeta | 20 | Keep | Ignore';
  const [table]=parseMarkdown(source);assert.deepEqual(table.align,['left','center','right']);
  assert.deepEqual(table.rows,[['Alpha','10',''],['Beta','20','Keep']]);
  assert.equal(elements(render(source),'td')[1].style.textAlign,'center');
});
test('escaped pipes and pipes inside inline code stay within their original cells',()=>{
  const source='| a\\|b | `c|d` |\n|---|---|\n| **Keep \\| here** | ``a|`b`` |';
  const [table]=parseMarkdown(source);assert.equal(table.header.length,2);assert.equal(table.rows[0].length,2);
  const root=render(source);assert.equal(elements(root,'th')[0].textContent,'a|b');
  assert.equal(elements(root,'strong')[0].textContent,'Keep | here');assert.equal(elements(root,'code')[1].textContent,'a|`b');
});
test('pipe text and fenced code remain text, with paragraphs around tables preserved',()=>{
  const source='Before\r\n\r\n```text\r\n| Header | Value |\r\n|---|---|\r\n| x | y |\r\n```\r\n\r\nPlain x | y sentence.\r\n\r\n'+sample+'\n\nAfter';
  const blocks=parseMarkdown(source);assert.deepEqual(blocks.map(block=>block.type),['paragraph','code','paragraph','table','paragraph']);
  assert.equal(elements(render(source),'table').length,1);assert.ok(elements(render(source),'pre')[0].textContent.includes('|---|---|'));
});
test('partial streamed tables can render at every character and complete without duplicate rows',()=>{
  for(let end=0;end<=sample.length;end++)assert.doesNotThrow(()=>render(sample.slice(0,end)));
  const headerEnd=sample.indexOf('\n| **1**');assert.equal(elements(render(sample.slice(0,headerEnd)),'table').length,1);
  const root=render(sample.slice(0,sample.indexOf('Reusable')+3));assert.equal(elements(root,'td').length,5);
  markdown(root,sample);assert.equal(elements(root,'td').length,10);assert.equal(elements(root,'table').length,1);
});
test('HTML in table cells and paragraphs stays inert while bold and code still render',()=>{
  const source='<script>alert(1)</script>\n\n| Name | Value |\n|---|---|\n| <img src=x onerror=alert(1)> | **safe** and `code` |';
  const root=render(source);assert.equal(elements(root,'script').length,0);assert.equal(elements(root,'img').length,0);
  assert.ok(root.textContent.includes('<img src=x onerror=alert(1)>'));assert.equal(elements(root,'strong')[0].textContent,'safe');assert.equal(elements(root,'code')[0].textContent,'code');
});
test('continued streaming preserves a table’s sideways reading position',()=>{
  const root=render(sample);root.children[0].scrollLeft=240;
  markdown(root,sample+'\n| 3 | Another task | More code | Review | Continue |');
  assert.equal(root.children[0].scrollLeft,240);assert.equal(elements(root,'td').length,15);
});
test('source citations render HTTP(S) links while executable link schemes stay text',()=>{
  const root=render('[Official source](https://example.org/report) and [unsafe](javascript:alert(1))');const links=elements(root,'a');assert.equal(links.length,1);assert.equal(links[0].attributes.href,'https://example.org/report');assert.equal(links[0].attributes.rel,'noopener noreferrer');
});
