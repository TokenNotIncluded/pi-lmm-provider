/* Copyright (C) 2026 LIghtJUNction. AGPL-3.0-or-later. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { REMOTE_PATH, deriveRemoteKey, encryptRemote, decryptRemote, remoteAad } from '../src/remote-wire.ts';

/** Local opaque relay fixture. Actual server OAuth is exercised in the main repo's Go tests. */
export async function remoteFixture(options = {}) {
  const sessions = new Map();
  const requests = [];
  let available = true;
  let authorized = true;
  let browserHandler;
  let eventStatus = 200;
  let postStatus = 200;
  const streams = new Set();
  const frame = (name, data) => `event: ${name}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
  function broadcast(id, name, data) {
    for (const stream of streams) if (stream.id === id) stream.res.write(frame(name, data));
  }
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://127.0.0.1');
    if (browserHandler && !url.pathname.startsWith(REMOTE_PATH)) { if (await browserHandler(req, res, url)) return; }
    requests.push({ path: url.pathname, query: url.search, method: req.method, body });
    res.setHeader('content-type', 'application/json');
    const answer = (status, data) => { res.writeHead(status); res.end(JSON.stringify(status < 300 ? { success: true, data } : { error: { code: status === 403 ? 'insufficient_scope' : 'fixture_error' } })); };
    if (!available) return answer(503, {});
    if (!authorized || req.headers.authorization !== 'Bearer lmm_at_fixture') return answer(403, {});
    if (!url.pathname.startsWith(REMOTE_PATH)) return answer(404, {});
    const [id, action] = url.pathname.slice(REMOTE_PATH.length + 1).split('/');
    if (!id && req.method === 'GET') return answer(200, [...sessions.values()].map(({ messages, next, ...session }) => session));
    if (req.method === 'PUT') {
      const input = JSON.parse(body);
      const session = sessions.get(id) ?? { session_id: id, generation: randomUUID(), next: 1, messages: [] };
      Object.assign(session, input, { updated_at: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + 120 });
      sessions.set(id, session);
      const { messages, next, ...wire } = session;
      return answer(200, wire);
    }
    if (req.method === 'DELETE') { sessions.delete(id); return answer(200, null); }
    const session = sessions.get(id);
    if (!session) return answer(404, {});
    if (action === 'events' && req.method === 'GET') {
      if (eventStatus !== 200) { res.setHeader('retry-after', options.retryAfter ?? '45'); return answer(eventStatus, {}); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.flushHeaders();
      const stream = { id, res }; streams.add(stream);
      const after = url.searchParams.get('generation') === session.generation ? Number(url.searchParams.get('after') ?? 0) : 0;
      if (!options.neverReady) res.write(frame('ready', { generation: session.generation, messages: session.messages.filter((entry) => entry.sequence > after) }));
      const keepalive = setInterval(() => res.write(': keepalive\r\n\r\n'), options.keepaliveMs ?? 15_000);
      const lease = setTimeout(() => res.end(), options.leaseMs ?? 60_000);
      res.on('close', () => { clearInterval(keepalive); clearTimeout(lease); streams.delete(stream); });
      return;
    }
    if (action === 'messages' && req.method === 'GET') return answer(200, { messages: session.messages.filter((entry) => entry.sequence > Number(url.searchParams.get('after') ?? 0)) });
    if (action === 'messages' && req.method === 'POST') {
      if (postStatus !== 200) { res.setHeader('retry-after', options.retryAfter ?? '45'); return answer(postStatus, {}); }
      const message = { ...JSON.parse(body), sequence: session.next++, created_at: Math.floor(Date.now() / 1000) };
      session.messages.push(message);
      if (session.messages.length > 128) session.messages.shift();
      broadcast(id, 'messages', { generation: session.generation, messages: [message] });
      return answer(200, message);
    }
    answer(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function post(id, input) {
    const response = await fetch(`${origin}${REMOTE_PATH}/${id}/messages`, {
      method: 'POST', headers: { authorization: 'Bearer lmm_at_fixture', 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Fixture HTTP ${response.status}`);
  }
  return {
    origin, sessions, requests, streams,
    setEventStatus(value) { eventStatus = value; },
    setPostStatus(value) { postStatus = value; },
    emit(id, name, data) { broadcast(id, name, data); },
    raw(id, chunks) { for (const stream of streams) if (stream.id === id) for (const chunk of chunks) stream.res.write(chunk); },
    endStreams() { for (const stream of streams) stream.res.end(); },
    setBrowserHandler(handler) { browserHandler = handler; },
    setAvailable(value) { available = value; if (!value) for (const stream of streams) { stream.res.write(frame('error', { code: 'remote_unavailable' })); stream.res.end(); } },
    setAuthorized(value) { authorized = value; if (!value) for (const stream of streams) { stream.res.write(frame('error', { code: 'unauthorized' })); stream.res.end(); } },
    restart() { sessions.clear(); for (const stream of streams) stream.res.end(); },
    post,
    async command(id, pin, input) {
      const command = { ...input, version: 1, type: 'command', id: input.id ?? randomUUID(), issued_at: input.issued_at ?? Date.now() };
      const key = await deriveRemoteKey(pin, id);
      await post(id, { sender: 'controller', ...await encryptRemote(key, command, remoteAad(id, 'message', 'controller')) });
      return command;
    },
    async events(id, pin) {
      const key = await deriveRemoteKey(pin, id);
      const result = [];
      for (const message of sessions.get(id)?.messages ?? []) {
        if (message.sender !== 'plugin') continue;
        try { result.push(await decryptRemote(key, message, remoteAad(id, 'message', 'plugin'))); } catch { /* negative cases */ }
      }
      return result;
    },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
export async function until(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(30);
  }
  throw new Error('Timed out waiting for remote integration condition');
}
