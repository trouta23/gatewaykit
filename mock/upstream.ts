import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { fileURLToPath } from 'node:url';

// A deliberately small upstream for tests and local demos:
//   GET  /healthz          200, or 503 after setHealthy(false)
//   ANY  …/status/:code    responds with that status
//   ANY  …/slow?ms=N       waits N ms before responding
//   ANY  …/flaky?fail=N    first N requests get 503, then 200
//   ANY  everything else   echoes the request back as JSON
// Behaviors match on the path suffix, so they work behind any route prefix.

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface MockUpstream {
  readonly name: string;
  readonly url: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  setHealthy(healthy: boolean): void;
  close(): Promise<void>;
}

export function startMockUpstream(name: string, port = 0): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  let healthy = true;
  let flakyFailures = 0;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(`http://mock${req.url ?? '/'}`);
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-upstream': name, server: 'mock-upstream' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/healthz') return send(healthy ? 200 : 503, { healthy });
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body });

    const status = /\/status\/(\d{3})$/.exec(url.pathname);
    if (status) return send(Number(status[1]), { upstream: name, status: Number(status[1]) });

    if (url.pathname.endsWith('/slow')) {
      await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get('ms') ?? 1000)));
    }
    if (url.pathname.endsWith('/flaky') && flakyFailures < Number(url.searchParams.get('fail') ?? 2)) {
      flakyFailures += 1;
      return send(503, { upstream: name, error: 'flaky' });
    }
    send(200, { upstream: name, method: req.method, url: req.url, headers: req.headers, body });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        name,
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requests,
        setHealthy: (value) => {
          healthy = value;
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

// `npm run mock` starts one upstream per service in config/gateway.yaml.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const services = ['users', 'orders', 'products-a', 'products-b', 'legacy', 'internal'];
  for (const [i, name] of services.entries()) {
    const mock = await startMockUpstream(name, 3001 + i);
    console.log(`mock upstream "${name}" on ${mock.url}`);
  }
}
