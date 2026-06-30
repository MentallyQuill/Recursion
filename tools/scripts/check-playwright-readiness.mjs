import {
  isDirectRun,
  printReportAndSetExitCode,
  runPlaywrightReadiness
} from './lib/sillytavern-live-harness.mjs';

export { runPlaywrightReadiness };

if (isDirectRun(import.meta.url)) {
  const report = await runPlaywrightReadiness({ argv: process.argv.slice(2) });
  printReportAndSetExitCode(report);
}
