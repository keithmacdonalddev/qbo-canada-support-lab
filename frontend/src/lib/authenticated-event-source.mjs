// Fetch supports Authorization headers; tickets and URLs never carry the JWT.
export class AuthenticatedEventSource {
  constructor(url, { token = globalThis.localStorage?.getItem('token'), fetcher = globalThis.fetch, headers = {} } = {}) {
    this.listeners = new Map()
    this.controller = new AbortController()
    this.closed = false
    this.done = this.read(url, token, fetcher, headers)
  }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback) }
  dispatch(type, data) { if (this.closed) return; for (const callback of this.listeners.get(type) || []) callback({ type, data }) }
  close() { this.closed = true; this.controller.abort() }
  async read(url, token, fetcher, headers = {}) {
    let reader
    try {
      const response = await fetcher(url, { headers: { ...headers, Authorization: 'Bearer ' + token, Accept: 'text/event-stream' }, signal: this.controller.signal, credentials: 'same-origin' })
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw Error('Stream unavailable')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = '', event = 'message', lines = [], frameLength = 0
      const line = value => {
        if (!value) { if (lines.length) this.dispatch(event, lines.join('\n')); event = 'message'; lines = []; frameLength = 0; return }
        frameLength += value.length
        if (frameLength > 1024 * 1024) throw Error('Stream frame too large')
        if (value.startsWith('event:')) event = value.slice(6).trimStart()
        if (value.startsWith('data:')) lines.push(value.slice(5).replace(/^ /, ''))
      }
      while (!this.closed) {
        const chunk = await reader.read()
        if (this.closed || chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        if (pending.length > 1024 * 1024) throw Error('Stream frame too large')
        let position
        while (!this.closed && (position = pending.indexOf('\n')) >= 0) { line(pending.slice(0, position).replace(/\r$/, '')); pending = pending.slice(position + 1) }
      }
      if (!this.closed) this.dispatch('error', '')
    } catch { if (!this.closed) this.dispatch('error', '') }
    finally { await reader?.cancel().catch(() => {}); reader?.releaseLock() }
  }
}
