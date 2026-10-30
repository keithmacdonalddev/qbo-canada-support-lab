'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeUsage,estimateCost,reviewPause,windows,createBusinessAgentUsage}=require('../src/modules/business-agent-usage');
const {codexSubscriptionQuota,normalizeQuotaReset}=require('../src/modules/codex-subscription-quota');
const scope={environment:'production',realmId:'123',connectionId:'a'.repeat(24)},clock=Date.parse('2026-10-29T12:00:00Z');
test('API estimate charges uncached input, output, cache writes by duration and reads once',()=>{
 const usage=normalizeUsage('anthropic',{input_tokens:1000000,output_tokens:100000,cache_read_input_tokens:2000000,cache_creation_input_tokens:1000000,cache_creation:{ephemeral_1h_input_tokens:400000}});
 assert.equal(usage.totalTokens,4100000);assert.equal(estimateCost('anthropic','claude-sonnet-5-5',usage),6.3);
 assert.equal(estimateCost('codex','gpt-6.1-sol',usage),null);assert.equal(estimateCost('anthropic','unknown',usage),null);
 assert.equal(estimateCost('anthropic','claude-opus-5-5',normalizeUsage('anthropic',null)),null);
 assert.equal(normalizeUsage('codex',{inputTokens:10,outputTokens:5}).totalTokens,15);
});
test('native quota error wrappers alone establish limit and bounded future reset',()=>{
 const reset=Math.floor(clock/1000)+3600;
 assert.deepEqual(codexSubscriptionQuota([{type:'turn.failed',error:{error:{code:'usage_limit_reached',resets_at:reset}}}],{now:clock}),{code:'CODEX_SUBSCRIPTION_LIMIT',resetAt:'2026-10-29T13:00:00.000Z'});
 assert.equal(codexSubscriptionQuota([{type:'item.completed',item:{type:'agent_message',text:'you have hit your usage limit',error:{code:'usage_limit_reached',reset_at:reset}}}],{now:clock}),null);
 assert.equal(codexSubscriptionQuota([{type:'error',message:'you have hit your usage limit, reset 2099-01-01'}],{now:clock}).resetAt,null);
 assert.equal(normalizeQuotaReset(reset*1000,clock),null);assert.equal(normalizeQuotaReset(reset-7200,clock),null);assert.equal(normalizeQuotaReset(reset+40*86400,clock),null);
 assert.equal(codexSubscriptionQuota([{type:'error',message:'x'.repeat(21000),code:'usage_limit_reached'}],{now:clock}),null);
});
test('monthly caps include equality and zero; reset at UTC month boundary; auto respects plan pause',()=>{
 const usage={month:{totalTokens:100,estimatedCostUsd:2}};
 assert.equal(reviewPause(usage,{monthlyCaps:{tokens:100}},null,clock).code,'monthly-cap');
 assert.equal(reviewPause(usage,{monthlyCaps:{apiUsd:2}},null,clock).resetAt,'2026-11-01T00:00:00.000Z');
 assert.equal(reviewPause({month:{}},{monthlyCaps:{tokens:0}},null,clock).code,'monthly-cap');
 assert.equal(reviewPause({month:{}},{monthlyCaps:{tokens:null,apiUsd:null}},null,clock),null);
 const quota={resetAt:'2026-10-29T13:00:00Z'};
 assert.equal(reviewPause(usage,{},quota,clock,'auto').code,'plan-limit');assert.equal(reviewPause(usage,{},quota,clock,'anthropic'),null);
 assert.equal(reviewPause(usage,{},quota,clock+3600000,'codex'),null);
 assert.equal(reviewPause(usage,{}, {resetAt:null},clock,'auto').code,'plan-limit');
 assert.equal(reviewPause({month:{missingUsageReviews:1}},{monthlyCaps:{tokens:100}},null,clock).code,'missing-usage');
 assert.equal(reviewPause({unavailable:true},{},null,clock).code,'usage-unavailable');
 assert.equal(reviewPause({month:{unpricedReviews:1}},{monthlyCaps:{apiUsd:10}},null,clock).code,'unpriced-usage');
 assert.equal(windows(Date.parse('2027-01-01T00:00:00Z')).month.toISOString(),'2027-01-01T00:00:00.000Z');
});
test('usage storage is scoped, indexed, expires after 180 days and drops prompts/keys',async()=>{
 const Model=require('../src/models/BusinessAgentUsage');assert.ok(Model.schema.indexes().some(([,options])=>options.expireAfterSeconds===180*86400));assert.equal(Model.schema.options.autoCreate,false);
 let created,updated,query,pipeline;const calls=[];
 const Usage={createCollection:async()=>calls.push('collection'),createIndexes:async()=>calls.push('indexes'),create:async value=>{created=value;},updateOne:async(filter,changes)=>{query=filter;updated=changes.$set;return {matchedCount:1};},aggregate:stages=>{pipeline=stages;return {option:async()=>[{month:[{reviews:1,totalTokens:15,estimatedCostUsd:0}],models:[{_id:{provider:'codex',model:'gpt-6.1-sol',role:'accountant',billing:'included in plan'},reviews:1,totalTokens:15}],latest:[{provider:'codex',model:'gpt-6.1-sol'}]}]};},findOne:filter=>{assert.equal(filter.realmId,scope.realmId);return {sort(){return this;},select(){return this;},maxTimeMS(){return this;},lean:async()=>null};}};
 const store=createBusinessAgentUsage({Usage,now:()=>clock});const record=await store.begin(scope,{provider:'codex',model:'gpt-6.1-sol',role:'accountant',prompt:'private'});
 await store.save(record,{...normalizeUsage('codex',{inputTokens:10,outputTokens:5}),outcome:'completed',prompt:'private',key:'private'});
 assert.equal(created.prompt,undefined);assert.equal(updated.prompt,undefined);assert.equal(updated.key,undefined);assert.equal(query.connectionId,scope.connectionId);assert.deepEqual(calls,['collection','indexes']);
 const result=await store.summary(scope);assert.equal(pipeline[0].$match.connectionId,scope.connectionId);assert.equal(result.models[0].billing,'included in plan');assert.equal(result.month.totalTokens,15);assert.equal(result.today.reviews,0);
 const unpriced=pipeline[1].$facet.month[1].$group.unpricedReviews;assert.match(JSON.stringify(unpriced),/running/);assert.ok(JSON.stringify(unpriced).includes('$$NOW'));
});

test('monthly cap controls validate exact fields, bounds and owner reset semantics',()=>{
 const {validateControl,reduceControl}=require('../src/modules/business-agent-policy');
 const input={command:'configure-usage',expectedRevision:2,requestKey:'usage_control_fixture_0001',settings:{apiUsd:12.34,tokens:10000}};
 assert.equal(validateControl(input),input);const row={settings:{autonomous:true,monitoring:true}};
 assert.deepEqual(reduceControl(row,input,{scope},clock,'owner').settings.monthlyCaps,input.settings);
 for(const settings of [{apiUsd:-1,tokens:null},{apiUsd:Infinity,tokens:null},{apiUsd:1.001,tokens:null},{apiUsd:null,tokens:1.1},{apiUsd:null,tokens:10,realmId:'other'}])assert.throws(()=>validateControl({...input,settings}));
 assert.throws(()=>reduceControl({...row,codexQuota:{resetAt:new Date(clock+60000).toISOString()}},{command:'retry-plan-limit'},{scope},clock,'owner'),/Wait/);
 const cleared=reduceControl({...row,codexQuota:{resetAt:null}},{command:'retry-plan-limit'},{scope},clock,'owner');assert.equal(cleared.codexQuota,null);assert.equal(+cleared.codexQuotaClearedAt,clock);
});

test('Codex usage splits fresh and cached input without changing token totals',()=>{
 const split=normalizeUsage('codex',{inputTokens:1000,cachedInputTokens:800,outputTokens:100});
 assert.equal(split.inputTokens,200);assert.equal(split.cacheReadTokens,800);assert.equal(split.totalTokens,1100);assert.equal(split.cacheSplit,true);
 const legacy=normalizeUsage('codex',{inputTokens:1000,outputTokens:100});
 assert.equal(legacy.inputTokens,1000);assert.equal(legacy.cacheReadTokens,0);assert.equal(legacy.totalTokens,1100);assert.equal(legacy.cacheSplit,false);
 assert.equal(normalizeUsage('codex',{inputTokens:10,cachedInputTokens:null,outputTokens:1}).cacheSplit,false);
 const clamped=normalizeUsage('codex',{inputTokens:10,cachedInputTokens:50,outputTokens:1});assert.equal(clamped.inputTokens,0);assert.equal(clamped.cacheReadTokens,10);assert.equal(clamped.totalTokens,11);
 assert.equal(normalizeUsage('anthropic',{input_tokens:1,output_tokens:1}).cacheSplit,true);
 assert.equal(estimateCost('codex','gpt-6.1-sol',split),null);assert.equal(estimateCost('anthropic','gpt-6.1-sol',normalizeUsage('anthropic',{input_tokens:1,output_tokens:1})),null);
});
test('API-equivalent prices Codex exactly, bounds legacy rows, leaves unknown models unpriced and keeps Anthropic estimates',()=>{
 const {apiEquivalent}=require('../src/modules/business-agent-usage');const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,a+' != '+b);
 const exact=apiEquivalent({provider:'codex',model:'gpt-6.1-sol',reviews:1,inputTokens:1e6,cacheReadTokens:4e6,outputTokens:1e5});
 near(exact.lowUsd,3.4);near(exact.highUsd,3.4);assert.equal(exact.legacyReviews,0);assert.equal(exact.unpricedReviews,0);
 const legacy=apiEquivalent({provider:'codex',model:'gpt-6.1-sol',reviews:1,inputTokens:1e6,outputTokens:1e5,legacyReviews:1,legacyInputTokens:1e6,legacyOutputTokens:1e5});
 near(legacy.lowUsd,1.1);near(legacy.highUsd,3);assert.equal(legacy.legacyReviews,1);
 const mixed=apiEquivalent({provider:'codex',model:'gpt-6-luna',reviews:2,inputTokens:2e6,cacheReadTokens:1e6,outputTokens:2e5,legacyReviews:1,legacyInputTokens:1e6,legacyOutputTokens:1e5});
 near(mixed.lowUsd,0.1+0.01+0.05+0.01+0.05);near(mixed.highUsd,0.1+0.01+0.05+0.1+0.05);
 assert.deepEqual(apiEquivalent({provider:'codex',model:'gpt-unknown',reviews:2,inputTokens:1e6}),{lowUsd:0,highUsd:0,unpricedReviews:2,legacyReviews:0});
 assert.equal(apiEquivalent({provider:'codex',model:'claude-sonnet-5-5',reviews:1}).unpricedReviews,1);
 assert.deepEqual(apiEquivalent({provider:'anthropic',model:'claude-sonnet-5-5',reviews:3,estimatedCostUsd:6.3,unpricedReviews:1,inputTokens:9e9}),{lowUsd:6.3,highUsd:6.3,unpricedReviews:1,legacyReviews:0});
});
test('API spend cap counts actual API spend only, never the API-equivalent comparison',()=>{
 assert.equal(reviewPause({month:{estimatedCostUsd:0,unpricedReviews:0,apiEquivalent:{lowUsd:50,highUsd:60,unpricedReviews:2,legacyReviews:1}}},{monthlyCaps:{apiUsd:1}},null,clock),null);
 assert.equal(reviewPause({month:{estimatedCostUsd:1,apiEquivalent:{lowUsd:0,highUsd:0}}},{monthlyCaps:{apiUsd:1}},null,clock).code,'monthly-cap');
});
test('summary prices each window and model from grouped rows and retains the cache split flag',async()=>{
 let pipeline,updated;
 const groups=[{_id:{provider:'codex',model:'gpt-6.1-sol'},reviews:2,inputTokens:2e6,cacheReadTokens:4e6,outputTokens:2e5,totalTokens:8.2e6,estimatedCostUsd:0,unpricedReviews:0,legacyReviews:1,legacyInputTokens:1e6,legacyOutputTokens:1e5},{_id:{provider:'anthropic',model:'claude-sonnet-5-5'},reviews:1,estimatedCostUsd:0.5,unpricedReviews:0,legacyReviews:0,legacyInputTokens:0,legacyOutputTokens:0}];
 const Usage={createCollection:async()=>{},createIndexes:async()=>{},create:async()=>{},updateOne:async(filter,changes)=>{updated=changes.$set;return {matchedCount:1};},aggregate:stages=>{pipeline=stages;return {option:async()=>[{month:[{_id:null,reviews:3,totalTokens:8.2e6,estimatedCostUsd:0.5}],monthPricing:groups,models:[{...groups[0],_id:{...groups[0]._id,role:'accountant',billing:'included in plan'}}],latest:[]}]};},findOne:()=>({sort(){return this;},select(){return this;},maxTimeMS(){return this;},lean:async()=>null})};
 const store=createBusinessAgentUsage({Usage,now:()=>clock});const record=await store.begin(scope,{provider:'codex',model:'gpt-6.1-sol',role:'accountant',billing:'included in plan'});
 assert.equal(record.cacheSplit,false);await store.save(record,normalizeUsage('codex',{inputTokens:10,cachedInputTokens:4,outputTokens:1}));assert.equal(updated.cacheSplit,true);assert.equal(updated.cacheReadTokens,4);
 const result=await store.summary(scope);const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,a+' != '+b);
 // exact half: 1e6 fresh*2 + 4e6 cached*0.1 + 1e5 out*10 = 3.4; legacy half: 1e6 in + 1e5 out = 1.1..3; Anthropic 0.5.
 near(result.month.apiEquivalent.lowUsd,3.4+1.1+0.5);near(result.month.apiEquivalent.highUsd,3.4+3+0.5);assert.equal(result.month.apiEquivalent.legacyReviews,1);
 assert.equal(result.month.estimatedCostUsd,0.5);assert.equal(result.today.apiEquivalent.lowUsd,0);assert.equal(result.monthPricing,undefined);
 near(result.models[0].apiEquivalent.lowUsd,4.5);assert.equal(result.models[0].legacyInputTokens,undefined);assert.equal(result.models[0].billing,'included in plan');
 const facet=pipeline[1].$facet;assert.ok(facet.todayPricing&&facet.weekPricing&&facet.monthPricing);assert.match(JSON.stringify(facet.models[1].$group.legacyInputTokens),/cacheSplit/);
});
