'use strict';
const {createHash}=require('node:crypto');
// Retains only target selectors: scheme, hosts, effective database, replica set
// and SRV service. Userinfo, authentication, TLS and other query data are excluded.
function storageTarget(uri){
 if(typeof uri!=='string')throw new Error('A configured MongoDB storage target is required.');
 const match=/^(mongodb(?:\+srv)?):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?[^#]*)?$/.exec(uri);
 if(!match)throw new Error('The configured MongoDB storage target could not be identified.');
 const authority=match[2].slice(match[2].lastIndexOf('@')+1).toLowerCase();
 let hosts=authority.split(',').map(host=>{
  if(!/^(?:[a-z0-9._-]+|\[[a-f0-9:]+\])(?::[0-9]{1,5})?$/.test(host))throw new Error('The configured MongoDB storage target could not be identified.');
  if(match[1]==='mongodb'&&!/:[0-9]+$/.test(host))return host+':27017';return host;
 });
 hosts=[...new Set(hosts)].sort();
 const selectors=new Map();
 for(const [key,value]of new URLSearchParams(uri.includes('?')?uri.slice(uri.indexOf('?')+1):'')){
  const name=key.toLowerCase();if(!['dbname','srvservicename','replicaset'].includes(name))continue;
  if(selectors.has(name)||!value)throw new Error('Ambiguous MongoDB storage target selectors.');selectors.set(name,value);
 }
 let database;try{database=match[3]?decodeURIComponent(match[3]):selectors.get('dbname')||'test';}catch{throw new Error('The configured database name could not be identified.');}
 const descriptor={scheme:match[1],hosts,database,replicaSet:selectors.get('replicaset')||null,srvServiceName:match[1]==='mongodb+srv'?(selectors.get('srvservicename')||'mongodb'):null};
 return {descriptor,fingerprint:createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')};
}
function configureDatabaseDns(value=process.env.MONGODB_DNS_SERVERS,dns=require('node:dns')){
 if(typeof value!=='string'||!value.trim())return;
 const servers=value.split(',').map(server=>server.trim()).filter(Boolean);
 if(servers.length)dns.setServers(servers);
}
module.exports={storageTarget,configureDatabaseDns};
