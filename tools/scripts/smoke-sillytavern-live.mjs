import {
  isDirectRun,
  printReportAndSetExitCode,
  runSillyTavernLiveSmoke
} from './lib/sillytavern-live-harness.mjs';

export { runSillyTavernLiveSmoke };

if (isDirectRun(import.meta.url)) {
  const report = await runSillyTavernLiveSmoke({ argv: process.argv.slice(2) });
  printReportAndSetExitCode(report);
}
