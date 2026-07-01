import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const sourcePath = resolve('docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md');
const outputPath = resolve(process.argv[2] || '.tmp/recursion-bar-preview.html');
const source = readFileSync(sourcePath, 'utf8');

function fencedBlockAfter(header, language) {
  const headerIndex = source.indexOf(header);
  if (headerIndex === -1) throw new Error(`Missing ${header}`);

  const fence = `\`\`\`${language}`;
  const fenceIndex = source.indexOf(fence, headerIndex);
  if (fenceIndex === -1) throw new Error(`Missing ${fence} after ${header}`);

  const contentStart = source.indexOf('\n', fenceIndex) + 1;
  const contentEnd = source.indexOf('\n```', contentStart);
  if (contentStart === 0 || contentEnd === -1) throw new Error(`Unclosed ${fence} after ${header}`);

  return source.slice(contentStart, contentEnd).trim();
}

const markup = fencedBlockAfter('## HTML', 'html');
const turnAnimationScript = fencedBlockAfter('## Turn Animation Preview Script', 'html');
const styles = fencedBlockAfter('## CSS', 'css');

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Recursion Bar Preview</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 42px 16px;
      background: #111214;
      color: #e0e0e0;
      font-family: Arial, Helvetica, sans-serif;
    }
    .preview-shell {
      width: min(980px, calc(100vw - 32px));
    }

${styles}
  </style>
</head>
<body>
  <main class="preview-shell">
${markup.split('\n').map((line) => `    ${line}`).join('\n')}
  </main>
${turnAnimationScript}
</body>
</html>
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, page);
console.log(outputPath);
