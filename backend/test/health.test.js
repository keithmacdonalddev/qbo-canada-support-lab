'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')
const { createApp } = require('../src/app')

function healthFields({ app, status, database }) {
  return { app, status, database }
}

test('health identifies this app and reflects current database connectivity', async () => {
  let connected = true
  const server = http.createServer(createApp({ databaseReady: () => connected }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/health`
    const ready = await fetch(url)
    assert.equal(ready.status, 200)
    assert.deepEqual(healthFields(await ready.json()), {
      app: 'test-data-lab', status: 'ok', database: 'connected',
    })

    connected = false
    const unavailable = await fetch(url)
    assert.equal(unavailable.status, 503)
    assert.deepEqual(healthFields(await unavailable.json()), {
      app: 'test-data-lab', status: 'unavailable', database: 'disconnected',
    })
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
