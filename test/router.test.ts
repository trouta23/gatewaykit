import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateConfig } from '../src/config/validate.ts';
import { Router } from '../src/router.ts';

const router = new Router(
  validateConfig({
    routes: [
      { path: '/api/users', methods: ['GET'], upstream: { url: 'http://x' } },
      { path: '/api/users/admin', methods: ['GET'], upstream: { url: 'http://x' } },
      { path: '/api/products', methods: ['GET'], strip_prefix: true, upstream: { url: 'http://x' } },
    ],
  }).routes,
);

describe('Router', () => {
  it('matches exact paths and sub-paths on segment boundaries only', () => {
    assert.equal(router.match('/api/users')?.route.path, '/api/users');
    assert.equal(router.match('/api/users/42')?.route.path, '/api/users');
    assert.equal(router.match('/api/usersX'), undefined);
    assert.equal(router.match('/api'), undefined);
  });

  it('prefers the longest matching prefix', () => {
    assert.equal(router.match('/api/users/admin/1')?.route.path, '/api/users/admin');
  });

  it('strips the prefix only when configured', () => {
    assert.equal(router.match('/api/users/42')?.upstreamPath, '/api/users/42');
    assert.equal(router.match('/api/products/123')?.upstreamPath, '/123');
    assert.equal(router.match('/api/products')?.upstreamPath, '/');
  });

  it('lets a root route catch everything else', () => {
    const withRoot = new Router(validateConfig({ routes: [{ path: '/', methods: ['GET'], upstream: { url: 'http://x' } }] }).routes);
    assert.equal(withRoot.match('/anything/at/all')?.upstreamPath, '/anything/at/all');
  });
});
