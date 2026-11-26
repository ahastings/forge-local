function rowCells(line) {
  const cells=[];let cell='',ticks=0,pipes=0,lastPipe=false;
  const source=line.trim();
  for(let i=0;i<source.length;i++){
    const char=source[i];lastPipe=false;
    if(char==='\\'&&i+1<source.length){cell+=char+source[++i];continue;}
    if(char==='`'){
      let end=i+1;while(source[end]==='`')end++;
      const size=end-i;if(!ticks)ticks=size;else if(ticks===size)ticks=0;
      cell+=source.slice(i,end);i=end-1;continue;
    }
    if(char==='|'&&!ticks){cells.push(cell.trim());cell='';pipes++;lastPipe=true;}
    else cell+=char;
  }
  if(!pipes)return null;
  cells.push(cell.trim());
  if(source.startsWith('|'))cells.shift();
  if(lastPipe)cells.pop();
  return cells;
}

function tableHeader(lines,index){
  const header=rowCells(lines[index]||''),divider=rowCells(lines[index+1]||'');
  if(!header?.length||!divider||header.length!==divider.length||!divider.every(cell=>/^:?-{3,}:?$/.test(cell)))return null;
  return {type:'table',header,align:divider.map(cell=>cell.startsWith(':')&&cell.endsWith(':')?'center':cell.endsWith(':')?'right':'left'),rows:[]};
}
const fence=line=>/^ {0,3}(`{3,})[^`]*$/.exec(line);

export function parseMarkdown(text){
  const lines=String(text??'').replace(/\r\n?/g,'\n').split('\n'),blocks=[];
  for(let i=0;i<lines.length;){
    if(!lines[i].trim()){i++;continue;}
    const opening=fence(lines[i]);
    if(opening){
      const code=[],closing=new RegExp('^ {0,3}`{'+opening[1].length+',}\\s*$');i++;
      while(i<lines.length&&!closing.test(lines[i]))code.push(lines[i++]);
      if(i<lines.length)i++;
      blocks.push({type:'code',text:code.join('\n')});continue;
    }
    const table=tableHeader(lines,i);
    if(table){
      i+=2;
      while(i<lines.length&&lines[i].trim()&&!fence(lines[i])){
        const cells=rowCells(lines[i]);if(!cells)break;
        table.rows.push(table.header.map((_,column)=>cells[column]??''));i++;
      }
      blocks.push(table);continue;
    }
    const paragraph=[lines[i++]];
    while(i<lines.length&&lines[i].trim()&&!fence(lines[i])&&!tableHeader(lines,i))paragraph.push(lines[i++]);
    blocks.push({type:'paragraph',text:paragraph.join('\n').replace(/^#{1,6} /gm,'')});
  }
  return blocks;
}

function inline(parent,text,document){
  const pattern=/(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|\\([\\|*`])/g;let start=0;
  for(const match of text.matchAll(pattern)){
    parent.append(document.createTextNode(text.slice(start,match.index)));
    if(match[1]){const code=document.createElement('code');code.textContent=match[2];parent.append(code);}
    else if(match[3]){const strong=document.createElement('strong');inline(strong,match[3],document);parent.append(strong);}
    else parent.append(document.createTextNode(match[4]));
    start=match.index+match[0].length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}

// Build only known DOM elements. Model text is never interpreted as HTML.
export function markdown(parent,text){
  const document=parent.ownerDocument,offsets=Array.from(parent.children).filter(node=>node.className==='markdown-table').map(node=>node.scrollLeft||0);let tableIndex=0;parent.replaceChildren();
  for(const block of parseMarkdown(text)){
    if(block.type==='code'){
      const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=block.text;pre.append(code);parent.append(pre);
    }else if(block.type==='table'){
      const wrapper=document.createElement('div'),table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody'),heading=document.createElement('tr');
      wrapper.className='markdown-table';wrapper.tabIndex=0;wrapper.setAttribute('role','region');wrapper.setAttribute('aria-label','Scrollable table');
      table.style.setProperty('--table-min-width',Math.max(320,block.header.length*160)+'px');
      const addRow=(row,cells,header=false)=>cells.forEach((text,column)=>{const cell=document.createElement(header?'th':'td');if(header)cell.setAttribute('scope','col');cell.style.textAlign=block.align[column];inline(cell,text,document);row.append(cell);});
      addRow(heading,block.header,true);head.append(heading);
      for(const cells of block.rows){const row=document.createElement('tr');addRow(row,cells);body.append(row);}
      table.append(head,body);wrapper.append(table);parent.append(wrapper);wrapper.scrollLeft=offsets[tableIndex++]||0;
    }else{const paragraph=document.createElement('p');inline(paragraph,block.text,document);parent.append(paragraph);}
  }
}
