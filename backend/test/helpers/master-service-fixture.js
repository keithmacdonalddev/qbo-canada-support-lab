'use strict';
const { scenario } = require('./master-preparation-scenario');
const { remoteMasters } = require('./master-preparation-remote');
const { scope, ownerId } = require('./master-transport-fixture');
const { createBusinessRuntimeAccess } = require('../../src/modules/business-runtime-access');
const { createMasterRuntime } = require('../../src/modules/business-master-runtime');
const { createMasterService } = require('../../src/modules/business-master-service');
function fixture(t, options = {}) {
  const h = scenario(); t.mock.method(Date, 'now', () => h.clock); remoteMasters(h); h.qboReads = []; h.workQueries = []; h.setups = [];
  const original = h.onGET; h.onGET = async opts => { h.qboReads.push(opts.url); return original(opts); };
  h.db.collection = name => ({ findOne: async (filter, settings) => { h.workQueries.push({name,filter,settings}); return h.busyCollection === name ? {_id:'earlier-work'} : null; }, find: () => ({ limit() { return this; }, toArray: async () => [] }) });
  h.connection = { db: h.db, getClient: () => ({}) };
  h.assertReady = async () => { if (h.unprepared) throw Object.assign(Error('Fixture storage requires reviewed preparation.'),{status:409,code:'BUSINESS_STORAGE_UNPREPARED'}); };
  h.resolveContext = async () => ({ environment: scope.environment, connection: { connected:true,...scope,companyName:'Fixture Harbour Business' } });
  h.accessFor = input => createBusinessRuntimeAccess({...h.models,...input,environment:()=>scope.environment,createClient:async()=>h.client});
  h.runtimeFor = input => createMasterRuntime({...input,models:h.models,connection:h.connection,transaction:h.transaction,assertReady:h.assertReady,createClient:async()=>h.client,environment:()=>scope.environment,now:()=>h.clock});
  h.service = createMasterService({models:h.models,connection:h.connection,resolveContext:h.resolveContext,accessFor:h.accessFor,runtimeFor:h.runtimeFor,now:()=>h.clock,previewSetup:async(...args)=>{h.setups.push(args);return{planHash:'c'.repeat(64),qboWrites:0};},applySetup:async(...args)=>{h.setups.push(args);return{status:'complete',qboWrites:0};},...options});
  h.user={id:ownerId}; h.body={...h.source.input,requestKey:'10000000-0000-0000-0000-000000000001'};
  h.proposal=()=>h.service.prepare(h.user,h.body);
  h.approval=()=>h.service.approve(h.user,String(h.run()._id),{planHash:h.run().planHash,productionConfirmed:true});
  return h;
}
module.exports={fixture,scope,ownerId};
