import { inspectWindowsToolchainPrerequisites } from '../lib/transport/windows-toolchain-prerequisites.mjs';

if (process.argv.length !== 2) {
  process.stderr.write('Usage: node tools/qa/check-windows-toolchain.mjs\nDiagnostic only; no arguments, tool overrides or qualification authority.\n');
  process.exitCode = 2;
} else {
  try {
    const report = inspectWindowsToolchainPrerequisites();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.status === 'prerequisites-match' ? 0
      : report.status === 'prerequisites-blocked' ? 1 : 2;
  } catch (error) {
    process.stderr.write(`Windows prerequisite diagnostic failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}
