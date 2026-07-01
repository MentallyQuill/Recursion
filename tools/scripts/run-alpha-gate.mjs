import './run-tests.mjs';
import { runPlaywrightReadiness } from './check-playwright-readiness.mjs';

const readiness = await runPlaywrightReadiness({ argv: [] });
if (readiness.status !== 'pass') {
  console.error(JSON.stringify(readiness, null, 2));
  process.exitCode = 1;
} else {
  process.stdout.write('[pass] playwright readiness\n');
  process.stdout.write('[pass] recursion alpha gate\n');
}
