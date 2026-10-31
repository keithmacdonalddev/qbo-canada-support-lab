'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
// The staging hook lets this job test the exact candidate before nodemon sees one source save.
const cache=new Map();
function load(relative) {
 const filename=path.resolve(__dirname,'../../src',relative),stage=process.env.QBO_CLOSE_STAGE;
 if(!stage||!fs.existsSync(path.join(stage,relative))) return require(filename);
 if(cache.has(filename)) return cache.get(filename).exports;
 const compiled=new Module(filename,module);compiled.filename=filename;compiled.paths=Module._nodeModulePaths(path.dirname(filename));cache.set(filename,compiled);
 const original=Module.createRequire(filename);
 compiled.require=id=>{if(id.startsWith('.')) {const target=path.resolve(path.dirname(filename),id)+(path.extname(id)?'':'.js'),rel=path.relative(path.resolve(__dirname,'../../src'),target);if(fs.existsSync(path.join(stage,rel)))return load(rel);}return original(id);};
 compiled._compile(fs.readFileSync(path.join(stage,relative),'utf8'),filename);return compiled.exports;
}
module.exports={load};
