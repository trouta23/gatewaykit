import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { rawRequest, startGateway } from './helpers.ts';
import type { TestGateway } from './helpers.ts';

interface Exchange {
  /** Resolves when the upstream receives the request. */
  received: Promise<void>;
  /** Resolves when the upstream's socket for that request closes. */
  closed: Promise<void>;
  resolveReceived(): void;
  resolveClosed(): void;
}

// An upstream with transport-level misbehaviors the shared mock can't produce.
// Behaviors match on the path suffix; each test uses its own path so it can
// watch exactly its own upstream connection.
async function startUpstream() {
  const exchanges = new Map<string, Exchange>();
  const exchange = (path: string): Exchange => {
    let found = exchanges.get(path);
    if (!found) {
      const received = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      found = {
        received: received.promise,
        closed: closed.promise,
        resolveReceived: received.resolve,
        resolveClosed: closed.resolve,
      };
      exchanges.set(path, found);
    }
    return found;
  };
  const recorded = new Map<string, { headers: http.IncomingHttpHeaders; body: Buffer }>();

  const server = http.createServer(async (req, res) => {
    const path = req.url ?? '/';
    const ex = exchange(path);
    req.socket.once('close', ex.resolveClosed);
    ex.resolveReceived();

    // Answers at once without reading the upload.
    if (path.endsWith('/early')) return void res.end('early');
    // Never answers.
    if (path.endsWith('/hang')) return;
    // Promises 100 bytes, sends 7, then drops the connection.
    if (path.endsWith('/partial')) {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 100 });
      res.write('partial');
      setImmediate(() => res.socket?.destroy());
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    recorded.set(path, { headers: req.headers, body });
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'set-cookie': ['a=1', 'b=2'],
      connection: 'keep-alive, x-internal',
      'x-internal': 'upstream-only',
      'keep-alive': 'timeout=99',
      'proxy-authenticate': 'Basic realm="upstream"',
    });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    exchange,
    recorded,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Fails instead of hanging when the gateway never tears the upstream down. */
async function within(promise: Promise<void>, ms: number, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function readBody(res: IncomingMessage): Promise<{ body: string; completed: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('error', () => {});
    res.on('close', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), completed: res.complete }));
  });
}

describe('transport hardening', () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>>;
  let gateway: TestGateway;
  let gatewayHost: string;

  before(async () => {
    upstream = await startUpstream();
    gateway = await startGateway({
      gateway: { port: 9998, global_timeout: '5s' },
      routes: [
        { path: '/patient', methods: ['GET', 'POST'], upstream: { url: upstream.url } },
        { path: '/hasty', methods: ['POST'], upstream: { url: upstream.url, timeout: '200ms' } },
      ],
    });
    gatewayHost = new URL(gateway.url).host;
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  function startUpload(path: string): http.ClientRequest {
    const { hostname, port } = new URL(gateway.url);
    const req = http.request({ hostname, port, path, method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
    req.on('error', () => {});
    req.write('first chunk of an upload that never finishes');
    return req;
  }

  it('keeps the deadline armed when the upstream answers before the upload finishes', async () => {
    const client = startUpload('/hasty/deadline/early');
    try {
      const [res] = (await once(client, 'response')) as [IncomingMessage];
      assert.equal(res.statusCode, 200);
      assert.equal((await readBody(res)).body, 'early');
      // The response is done but the upload is not: the 200ms route deadline must still tear it down.
      await within(upstream.exchange('/hasty/deadline/early').closed, 1500, 'upstream teardown after the deadline');
    } finally {
      client.destroy();
    }
  });

  it('aborts the upstream when the client leaves after an early response, mid-upload', async () => {
    const client = startUpload('/patient/leave/early');
    const [res] = (await once(client, 'response')) as [IncomingMessage];
    assert.equal((await readBody(res)).body, 'early');
    client.destroy();
    // Well before the 5s deadline: the disconnect itself must end the upstream exchange.
    await within(upstream.exchange('/patient/leave/early').closed, 1000, 'upstream teardown after the client left');
  });

  it('aborts the upstream request when the client disconnects while waiting', async () => {
    const { hostname, port } = new URL(gateway.url);
    const client = http.get({ hostname, port, path: '/patient/leave/hang' });
    client.on('error', () => {});
    await upstream.exchange('/patient/leave/hang').received;
    client.destroy();
    await within(upstream.exchange('/patient/leave/hang').closed, 1000, 'upstream teardown after the client left');
  });

  it('drops the client connection when the upstream fails mid-body, without a second status', async () => {
    const { hostname, port } = new URL(gateway.url);
    const client = http.get({ hostname, port, path: '/patient/partial' });
    client.on('error', () => {});
    const [res] = (await once(client, 'response')) as [IncomingMessage];
    assert.equal(res.statusCode, 200, 'the upstream status was already sent');
    const { body, completed } = await readBody(res);
    assert.equal(completed, false, 'the client must see a truncated response, not a clean end');
    assert.equal(body, 'partial', 'no 502 JSON is appended after the partial body');
  });

  it('strips hop-by-hop headers upstream and rewrites Host and X-Forwarded-*', async () => {
    const res = await rawRequest(gateway.url, '/patient/headers', {
      headers: {
        connection: 'x-client-hop',
        'x-client-hop': 'drop me',
        'keep-alive': 'timeout=99',
        te: 'trailers',
        'proxy-authorization': 'Basic c2VjcmV0',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'spoofed.example',
        'x-end-to-end': 'kept',
      },
    });
    assert.equal(res.status, 200);
    const { headers } = upstream.recorded.get('/patient/headers')!;
    for (const name of ['x-client-hop', 'keep-alive', 'te', 'proxy-authorization']) {
      assert.equal(headers[name], undefined, `${name} must not reach the upstream`);
    }
    assert.equal(headers['x-end-to-end'], 'kept');
    assert.equal(headers.host, upstream.host);
    assert.equal(headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(headers['x-forwarded-proto'], 'http');
    assert.equal(headers['x-forwarded-host'], gatewayHost);
  });

  it('strips hop-by-hop response headers and preserves repeated Set-Cookie', async () => {
    const res = await fetch(`${gateway.url}/patient/response-headers`);
    await res.arrayBuffer();
    assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2']);
    assert.equal(res.headers.get('x-internal'), null, 'a header named in Connection is hop-by-hop');
    assert.equal(res.headers.get('proxy-authenticate'), null);
    // Node sets its own Keep-Alive for the client hop; the upstream's value must not leak through.
    assert.notEqual(res.headers.get('keep-alive'), 'timeout=99');
  });

  it('passes binary bodies through byte-for-byte in both directions', async () => {
    // Every byte value, including NUL and invalid UTF-8 sequences.
    const payload = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256));
    const res = await fetch(`${gateway.url}/patient/binary`, { method: 'POST', body: payload });
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.recorded.get('/patient/binary')!.body, payload);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), payload);
  });
});
