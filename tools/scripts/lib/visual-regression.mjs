import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function assertVisualBaselineBuffer(actual, snapshotPath, { requireBaseline = true } = {}) {
  const actualSha256 = createHash('sha256').update(actual).digest('hex');
  if (!existsSync(snapshotPath)) {
    if (requireBaseline) throw new Error(`Visual baseline missing: ${snapshotPath}`);
    return {
      ok: true,
      snapshotPath,
      baseline: 'missing',
      sha256: actualSha256,
      actualSha256,
      expectedSha256: null
    };
  }
  const expected = readFileSync(snapshotPath);
  const actualWidth = actual.readUInt32BE(16);
  const actualHeight = actual.readUInt32BE(20);
  const expectedWidth = expected.readUInt32BE(16);
  const expectedHeight = expected.readUInt32BE(20);
  if (actualWidth !== expectedWidth || actualHeight !== expectedHeight) {
    throw new Error(`Visual baseline dimensions changed: ${snapshotPath}`);
  }
  const expectedSha256 = createHash('sha256').update(expected).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Visual baseline changed: ${snapshotPath} `
      + `(expected ${expectedSha256}, received ${actualSha256})`
    );
  }
  return {
    ok: true,
    snapshotPath,
    baseline: 'match',
    sha256: actualSha256,
    actualSha256,
    expectedSha256
  };
}

export async function assertVisualBaseline(locator, snapshotPath, { mask = [], requireBaseline = true } = {}) {
  const masks = mask.map((selector) => locator.locator(selector));
  const actual = await locator.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', mask: masks });
  return assertVisualBaselineBuffer(actual, snapshotPath, { requireBaseline });
}
