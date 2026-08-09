import {
  isDirectRun,
  printReportAndSetExitCode,
  runSoakUsersPreflight
} from './lib/sillytavern-live-harness.mjs';

export { runSoakUsersPreflight };

if (isDirectRun(import.meta.url)) {
  const report = await runSoakUsersPreflight({ argv: process.argv.slice(2) });
  printReportAndSetExitCode(report);
}
