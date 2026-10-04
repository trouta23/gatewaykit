// Manual QA runner: `npm run qa` runs every scenario; `npm run qa -- auth` runs one.
// Each scenario boots the real gateway process against mock upstreams and prints
// what happened, so a reviewer can re-run the evidence posted on each PR.
import auth from './auth.ts';
import circuitBreaker from './circuit-breaker.ts';
import core from './core.ts';
import headerTransforms from './header-transforms.ts';
import healthChecks from './health-checks.ts';
import loadBalancing from './load-balancing.ts';
import rateLimit from './rate-limit.ts';
import retry from './retry.ts';
import transport from './transport.ts';

const scenarios: Record<string, () => Promise<void>> = {
  core,
  auth,
  'rate-limit': rateLimit,
  'load-balancing': loadBalancing,
  'circuit-breaker': circuitBreaker,
  transport,
  'header-transforms': headerTransforms,
  'health-checks': healthChecks,
  retry,
};

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !(name in scenarios));
if (unknown.length > 0) {
  console.error(`Unknown scenario(s): ${unknown.join(', ')}. Available: ${Object.keys(scenarios).join(', ')}`);
  process.exit(1);
}

for (const name of requested.length > 0 ? requested : Object.keys(scenarios)) {
  console.log(`\n## ${name}`);
  await scenarios[name]!();
}
