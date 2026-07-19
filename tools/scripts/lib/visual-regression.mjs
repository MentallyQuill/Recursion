import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export async function assertVisualBaseline(locator, snapshotPath, { mask = [], requireBaseline = true } = {}) {
  const masks = mask.map((selector) => locator.locator(selector));
  const actual = await locator.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', mask: masks });
  if (!existsSync(snapshotPath)) {
    if (requireBaseline) throw new Error(`Visual baseline missing: ${snapshotPath}`);
    return { ok: true, snapshotPath, baseline: 'missing', sha256: createHash('sha256').update(actual).digest('hex') };
  }
  const expected = readFileSync(snapshotPath);
  const actualWidth = actual.readUInt32BE(16);
  const actualHeight = actual.readUInt32BE(20);
  const expectedWidth = expected.readUInt32BE(16);
  const expectedHeight = expected.readUInt32BE(20);
  if (actualWidth !== expectedWidth || actualHeight !== expectedHeight) {
    throw new Error(`Visual baseline dimensions changed: ${snapshotPath}`);
  }
  const actualHash = createHash('sha256').update(actual).digest('hex');
  const expectedHash = createHash('sha256').update(expected).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error(
      `Visual baseline changed: ${snapshotPath} `
      + `(expected ${expectedHash}, received ${actualHash})`
    );
  }
  return { ok: true, snapshotPath, baseline: 'match', sha256: actualHash, expectedSha256: expectedHash };
}
