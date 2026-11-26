import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

export function publicAddress(address){
  if(net.isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
  if(net.isIP(address)===6){const ip=address.toLowerCase(),parts=ip.split(':');return /^[23][0-9a-f]{3}:/.test(ip)&&!(parts[0]==='2001'&&parseInt(parts[1]||'0',16)<0x200)&&!ip.startsWith('2001:db8:')&&!ip.startsWith('2002:');}
  return false;
}
export function publicUrl(value,{allowMarketApi=false}={}){
  let url;try{url=new URL(value);}catch{throw new Error('Use a full public http or https URL.');}
  const host=url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();if(url.hostname.endsWith('.'))url.hostname=host;
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port&&!['80','443'].includes(url.port)||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||!host.includes('.')&&!net.isIP(host)||net.isIP(host)&&!publicAddress(host))throw new Error('Only public web pages on standard HTTP(S) ports are supported.');
  if([...url.searchParams.keys()].some(key=>/^(?:key|api[_-]?key|access[_-]?token|token|password|secret|client_secret|authorization|signature|sig|x-amz-(?:credential|signature|security-token))$/i.test(key)))throw new Error('Credential-bearing URLs cannot be saved or fetched.');
  if(!allowMarketApi&&/^(?:api|pro-api)\.coingecko\.com$/i.test(host))throw new Error('Use the project’s CoinGecko adapter and its saved request counter for market-data API calls.');
  url.hash='';for(const key of [...url.searchParams.keys()])if(/^utm_|^(?:gclid|fbclid)$/i.test(key))url.searchParams.delete(key);
  return url;
}
export function discoveryPage(value){
  const url=new URL(value),host=url.hostname.toLowerCase();
  return /(?:^|\.)bing\.com$/.test(host)&&/^\/(?:search|news\/search)\b/.test(url.pathname)||/(?:^|\.)google\.[a-z.]+$/.test(host)&&url.pathname==='/search'||/(?:^|\.)duckduckgo\.com$/.test(host)&&url.searchParams.has('q')||host==='search.yahoo.com'&&url.pathname==='/search'||host==='search.brave.com'&&url.pathname==='/search';
}
async function requestPage(url,address,{signal,maxBytes}){
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?https:http).request(url,{method:'GET',agent:false,signal,headers:{'User-Agent':'ForgeLocalResearch/0.6','Accept':'text/html,application/xhtml+xml,text/plain,application/json;q=0.8','Accept-Encoding':'identity'},lookup:(_host,options,callback)=>options?.all?callback(null,[address]):callback(null,address.address,address.family)},response=>{
      if([301,302,303,307,308].includes(response.statusCode)){response.resume();resolve({status:response.statusCode,headers:response.headers,text:''});return;}
      if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.resume();reject(new Error('The page returned an unsupported compressed response.'));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){response.destroy();reject(new Error('Page exceeds the 2 MB retrieval limit.'));}else chunks.push(chunk);});
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString('utf8')}));response.on('error',reject);
    });
    request.setTimeout(15_000,()=>request.destroy(new Error('Page retrieval timed out.')));request.on('error',reject);request.end();
  });
}
export async function fetchPublicPage(value,{signal,beforeRequest=async()=>{},lookup=dns.lookup,transport=requestPage,maxBytes=2_000_000}={}){
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(25_000)]):AbortSignal.timeout(25_000);let url=publicUrl(value);
  for(let redirect=0;redirect<=4;redirect++){
    combined.throwIfAborted();await beforeRequest(url.href);const host=url.hostname.replace(/^\[|\]$/g,'');
    const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await lookup(host,{all:true,verbatim:true});
    if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new Error('The web address resolves to a private or reserved network.');
    // Pin the validated address for this connection; redirects are resolved and checked again.
    combined.throwIfAborted();const response=await transport(url,addresses.find(item=>item.family===4)||addresses[0],{signal:combined,maxBytes});
    if([301,302,303,307,308].includes(response.status)){
      if(!response.headers.location||redirect===4)throw new Error('Page redirected too many times.');
      const next=publicUrl(new URL(response.headers.location,url).href);if(url.protocol==='https:'&&next.protocol==='http:')throw new Error('The page redirected from HTTPS to insecure HTTP.');url=next;continue;
    }
    return {...response,url:url.href};
  }
}

const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',rsquo:'’',lsquo:'‘',ldquo:'“',rdquo:'”'};
export function decodeHtml(text){return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(all,name)=>{if(name[0]==='#'){const value=name[1].toLowerCase()==='x'?parseInt(name.slice(2),16):Number(name.slice(1));return value>0&&value<=0x10ffff?String.fromCodePoint(value):all;}return entities[name.toLowerCase()]??all;});}
const clean=text=>decodeHtml(text.replace(/<[^>]*>/g,' ')).replace(/[\t ]+/g,' ').trim();
export function extractPage(body,type='text/html'){
  if(!/(?:text\/|application\/(?:json|xhtml\+xml|xml))/i.test(type))return {title:'',text:'',tables:[],links:[],publishedAt:null,extraction:'unsupported',note:'This content type is not extracted. PDF and interactive browser rendering are not available in this reader.'};
  if(!/html/i.test(type))return {title:'',text:body.slice(0,400_000),tables:[],links:[],publishedAt:null,extraction:'text',truncated:body.length>400_000};
  const title=clean(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]||'').slice(0,300);
  const date=/\b(?:property|name)\s*=\s*["'](?:article:published_time|datePublished|date)["'][^>]*\bcontent\s*=\s*["']([^"']+)/i.exec(body)?.[1];
  const publishedAt=date&&Number.isFinite(Date.parse(date))?new Date(date).toISOString():null;
  let html=body.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  const tables=[];html=html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi,table=>{
    const rows=[...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].slice(0,200).map(row=>[...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].slice(0,30).map(cell=>clean(cell[1]))).filter(row=>row.length);
    if(!rows.length)return clean(table);tables.push(rows);return '\n\n'+rows.map(row=>row.join(' | ')).join('\n')+'\n\n';
  });
  const links=[...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].slice(0,80).map(match=>({url:decodeHtml(match[1]),text:clean(match[2]).slice(0,150)}));
  const text=decodeHtml(html.replace(/<(?:br|hr)\b[^>]*>/gi,'\n').replace(/<\/(?:p|div|h[1-6]|li|section|article|tr)>/gi,'\n').replace(/<[^>]*>/g,' ')).replace(/[\t ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return {title,text:text.slice(0,400_000),tables,links,publishedAt,extraction:!tables.length&&text.length<200&&/<script\b/i.test(body)?'limited':'html',truncated:text.length>400_000,note:!tables.length&&text.length<200?'Little readable content was found; JavaScript, login or bot protection may be required.':''};
}
