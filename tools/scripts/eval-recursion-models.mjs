import { runModelEval } from './lib/model-eval-harness.mjs';
import { printReportAndSetExitCode } from './lib/sillytavern-live-harness.mjs';

const report = await runModelEval({
  argv: process.argv.slice(2),
  env: process.env
});

printReportAndSetExitCode(report, { exit: (code) => process.exit(code) });
