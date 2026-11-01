'use strict';
const { isDeepStrictEqual } = require('node:util');
const clone = value => structuredClone(value);
function values(obj, path) {
  if (!path.length) return [obj];
  if (Array.isArray(obj)) return obj.flatMap(x => values(x,path));
  return values(obj?.[path[0]], path.slice(1));
}
function testValue(value, wanted) {
  if (!wanted || typeof wanted !== 'object' || wanted instanceof Date || Array.isArray(wanted)) return isDeepStrictEqual(value,wanted);
  return Object.entries(wanted).every(([op,x]) => {
    if (op === '$in') return x.some(y=>testValue(value,y));
    if (op === '$nin') return !x.some(y=>testValue(value,y));
    if (op === '$ne') return !testValue(value,x);
    if (op === '$gte') return value >= x;
    if (op === '$gt') return value > x;
    if (op === '$lte') return value <= x;
    if (op === '$lt') return value < x;
    if (op === '$exists') return (value !== undefined) === x;
    if (op === '$elemMatch') return Array.isArray(value) && value.some(v=>matches(v,x));
    if (op === '$type') return typeof value === x;
    if (op.startsWith('$')) throw Object.assign(Error(),{code:'REPLAY_UNSUPPORTED_QUERY'});
    return testValue(value?.[op],x);
  });
}
function matches(row, filter = {}) {
  return Object.entries(filter).every(([key,x]) => key === '$or' ? x.some(f=>matches(row,f)) :
    key === '$and' ? x.every(f=>matches(row,f)) : values(row,key.split('.')).some(v=>testValue(v,x)));
}
// Mongoose queries are single-use thenables. Promise-only doubles concealed 96fe35a.
function query(rows, one = false) {
  let used = false, order, skip = 0, limit = Infinity;
  const q = {
    select(){return q;}, session(){return q;}, maxTimeMS(){return q;}, lean(){return q;},
    sort(v){order=v;return q;}, limit(v){limit=v;return q;}, skip(v){skip=v;return q;},
    async exec() {
      if (used) throw Object.assign(Error('Query was already executed'), { code:'REPLAY_QUERY_REEXECUTED' });
      used = true; let result = [...rows];
      if (order) result.sort((a,b)=>{for(const [key,d] of Object.entries(order)){const av=values(a,key.split('.'))[0],bv=values(b,key.split('.'))[0];if(av<bv)return -d;if(av>bv)return d;}return 0;});
      result=result.slice(skip,skip+limit);
      return clone(one ? result[0] || null : result);
    },
    then(resolve,reject){return q.exec().then(resolve,reject);}
  };
  return q;
}
function model(rows = [], { writable = false } = {}) {
  rows=writable?clone(rows):rows;
  const deny=()=>{throw Object.assign(Error(),{code:'REPLAY_STORAGE_WRITE_FORBIDDEN'});};
  return {
    find: filter=>query(rows.filter(r=>matches(r,filter))),
    findOne: filter=>query(rows.filter(r=>matches(r,filter)),true),
    countDocuments: filter=>Promise.resolve(rows.filter(r=>matches(r,filter)).length),
    create: writable ? async newRows=>{rows.push(...clone(newRows));return clone(newRows);} : deny,
    findOneAndUpdate: deny, updateOne:deny, updateMany:deny, deleteOne:deny,deleteMany:deny,
    aggregate: ()=>{throw Object.assign(Error(),{code:'REPLAY_UNSUPPORTED_AGGREGATION'});}
  };
}
module.exports = { query, model, matches };
