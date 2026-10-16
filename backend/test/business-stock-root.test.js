'use strict';
process.env.QBO_ENVIRONMENT='production';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/business-stock-fixture');
const stock=h=>[...h.records.values()].find(row=>row.entity==='Item'&&row.record.Type==='Inventory').record;
test('a changed original Item version cannot be washed back to zero and accepted',{timeout:120000},async t=>{
 const h=await fixture(t), item=stock(h);item.SyncToken='1';item.QtyOnHand=0;await assert.rejects(h.publish(),/changed after its original verified zero creation/);assert.equal(h.posts,0);assert.equal(h.data.Authorities.length,0);
});
test('a later Item update timestamp refuses ambiguous zero-stock history even with unchanged quantity and version',{timeout:120000},async t=>{
 const h=await fixture(t), item=stock(h);item.MetaData.LastUpdatedTime=new Date(Date.parse(item.MetaData.CreateTime)+1000).toISOString();await assert.rejects(h.publish(),/zero root|stock/i);assert.equal(h.posts,0);assert.equal(h.data.Authorities.length,0);
});
test('an unrelated Inventory Item on separate accounts does not prevent a five-product managed root',{timeout:120000},async t=>{
 const h=await fixture(t);h.records.set('item:9990',{entity:'Item',record:{Id:'9990',SyncToken:'0',Active:true,Type:'Inventory',TrackQtyOnHand:true,QtyOnHand:9,InvStartDate:'2020-01-01',AssetAccountRef:{value:'9877'},ExpenseAccountRef:{value:'9878'},MetaData:{CreateTime:'2020-01-01T00:00:00Z',LastUpdatedTime:'2020-01-01T00:00:00Z'}}});
 assert.equal((await h.publish()).published,true);const root=h.data.Authorities[0].payload.stockRoot;assert.equal(root.items.length,5);assert.equal(root.zeroSource.items.length,5);assert.equal(root.zeroSource.otherInventory.length,1);assert.equal(root.zeroSource.inventoryItemCount,6);assert.equal(root.zeroSource.otherInventory[0].itemId,'9990');assert.equal(h.posts,0);
});
test('other stock sharing either selected asset or COGS routing cannot enter a bounded managed-cost proof',{timeout:120000},async t=>{
 const h=await fixture(t);h.records.set('item:9990',{entity:'Item',record:{Id:'9990',SyncToken:'0',Active:true,Type:'Inventory',TrackQtyOnHand:true,QtyOnHand:0,InvStartDate:'2020-01-01',AssetAccountRef:{value:h.mappings.inventoryAsset},ExpenseAccountRef:{value:'9878'},MetaData:{CreateTime:'2020-01-01T00:00:00Z',LastUpdatedTime:'2020-01-01T00:00:00Z'}}});
 await assert.rejects(h.publish(),/Other inventory|separate physical/);assert.equal(h.data.Authorities.length,0);assert.equal(h.posts,0);
});
test('stock-root read failure stops admissions and drains the other original SDK call before rejecting',{timeout:120000},async t=>{
 const h=await fixture(t),before=h.reads;let calls=0,drained=false;
 h.onGet=async()=>{calls++;if(calls===1){await new Promise(resolve=>setTimeout(resolve,10));throw Object.assign(Error('Synthetic stock read refusal'),{code:'STOCK_SOURCE_FIXTURE'});}await new Promise(resolve=>setTimeout(resolve,40));drained=true;};
 await assert.rejects(h.stockInventory(),error=>error.name==='OAuthError'&&error.code==='OAUTH_ERROR'&&error.message==='Synthetic stock read refusal');assert.equal(drained,true);assert.equal(calls,2);assert.equal(h.reads-before,2);assert.equal(h.posts,0);
});
