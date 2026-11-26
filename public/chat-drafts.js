export class ChatDrafts {
  constructor(storage){try{this.storage=storage||globalThis.localStorage;this.values=JSON.parse(this.storage.getItem('forge.drafts.v1')||'{}');if(!this.values||typeof this.values!=='object'||Array.isArray(this.values))this.values={};}catch{this.values={};}}
  get(id){return typeof this.values[id]==='string'?this.values[id]:'';}
  save(id,text){if(!id)return;if(text)this.values[id]=text;else delete this.values[id];try{this.storage?.setItem('forge.drafts.v1',JSON.stringify(this.values));}catch{}}
}
