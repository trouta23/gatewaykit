import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('CLI startup', () => {
  it('exits 1 with every config problem listed, before binding a port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gatewaykit-'));
    const file = join(dir, 'bad.yaml');
    writeFileSync(file, 'gateway:\n  port: "eighty"\nroutes:\n  - path: /a\n    methods: [GET]\n');

    const result = spawnSync(process.execPath, ['src/main.ts', file], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gateway\.port: must be an integer/);
    assert.match(result.stderr, /routes\[0\]\.upstream: must be a mapping/);
  });

  it('reads the config path from GATEWAY_CONFIG when no argument is given', () => {
    const result = spawnSync(process.execPath, ['src/main.ts'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, GATEWAY_CONFIG: 'does/not/exist.yaml' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does\/not\/exist\.yaml: cannot read file/);
  });
});
