import test from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticatedEventSource } from '../src/lib/authenticated-event-source.mjs'
const stream = parts => new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close() } }), { headers: { 'content-type': 'text/event-stream' } })
test('authenticated stream keeps credentials in a header and handles split CRLF and multiline frames', async () => {
 let request
 const source = new AuthenticatedEventSource('/api/ai/stream/fixture?ticket=short', { token: 'private-fixture-token', fetcher: async (url, options) => { request = { url, options }; return stream(['event: token\r','\ndata: first\r\ndata: second\r\n\r','\nevent: done\ndata: {}\n\n']) } })
 const events=[];source.addEventListener('token', event=>events.push(event.data));source.addEventListener('done', event=>events.push(event.data));await source.done
 assert.deepEqual(events,['first\nsecond','{}']);assert.equal(request.options.headers.Authorization,'Bearer private-fixture-token');assert.equal(request.url.includes('private-fixture-token'),false)
})
test('failed authentication and malformed oversized frames do not deliver data', async () => {
 for (const response of [new Response('denied',{status:401}),stream(['data: '+ 'x'.repeat(1024*1024+1)+'\n\n'])]) {
  const source=new AuthenticatedEventSource('/fixture',{token:'fixture',fetcher:async()=>response}),events=[];source.addEventListener('message',event=>events.push(event.data));source.addEventListener('error',()=>events.push('error'));await source.done;assert.deepEqual(events,['error'])
 }
})
test('closing aborts the owned stream without a reconnect or error event', async () => {
 let signal
 const source=new AuthenticatedEventSource('/fixture',{token:'fixture',fetcher:async(_url,options)=>{signal=options.signal;return stream([])}}),errors=[];source.addEventListener('error',()=>errors.push(true));source.close();await source.done;assert.equal(signal.aborted,true);assert.deepEqual(errors,[])
})

test('closing during a buffered frame suppresses the remaining frames for that session', async () => {
 const source=new AuthenticatedEventSource('/fixture',{token:'fixture',fetcher:async()=>stream(['event: token\ndata: first\n\nevent: token\ndata: stale\n\n'])}),events=[]
 source.addEventListener('token',event=>{events.push(event.data);source.close()});await source.done;assert.deepEqual(events,['first'])
})
