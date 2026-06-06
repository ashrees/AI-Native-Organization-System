/**
 * Build PDF from assessment markdown via HTML + Chrome headless.
 */
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mdPath = join(__dirname, 'project-scalability-reliability-assessment.md');
const htmlPath = join(__dirname, 'project-scalability-reliability-assessment.html');
const pdfPath = join(__dirname, 'project-scalability-reliability-assessment.pdf');

const md = readFileSync(mdPath, 'utf8');

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mdToHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let inTable = false;
  let tableRow = 0;
  let inCode = false;
  let inUl = false;

  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
      tableRow = 0;
    }
  };
  const closeUl = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
  };

  for (let raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      if (!inCode) {
        closeTable();
        closeUl();
        out.push('<pre><code>');
        inCode = true;
      } else {
        out.push('</code></pre>');
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(raw) + '\n');
      continue;
    }
    if (line.startsWith('|') && line.endsWith('|')) {
      closeUl();
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) continue;
      if (!inTable) {
        out.push('<table><tbody>');
        inTable = true;
        tableRow = 0;
      }
      const tag = tableRow === 0 ? 'th' : 'td';
      out.push(
        '<tr>' + cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>'
      );
      tableRow += 1;
      continue;
    } else {
      closeTable();
    }
    if (line.startsWith('# ')) {
      closeUl();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith('## ')) {
      closeUl();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith('### ')) {
      closeUl();
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith('#### ')) {
      closeUl();
      out.push(`<h4>${inline(line.slice(5))}</h4>`);
    } else if (line.startsWith('- ')) {
      if (!inUl) {
        out.push('<ul>');
        inUl = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line === '---') {
      closeUl();
      out.push('<hr/>');
    } else if (line === '') {
      closeUl();
      out.push('<br/>');
    } else {
      closeUl();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeTable();
  closeUl();
  return out.join('\n');
}

function inline(s) {
  let t = escapeHtml(s);
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t;
}

const body = mdToHtml(md);
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Project Scalability &amp; Reliability Assessment</title>
<style>
  @page { margin: 18mm 16mm; size: A4; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.45;
    color: #1a1a1a;
    max-width: 100%;
  }
  h1 { font-size: 20pt; color: #0d3b66; border-bottom: 2px solid #0d3b66; padding-bottom: 6px; margin-top: 0; }
  h2 { font-size: 14pt; color: #145374; margin-top: 1.2em; page-break-after: avoid; }
  h3 { font-size: 11.5pt; color: #333; margin-top: 1em; page-break-after: avoid; }
  h4 { font-size: 10.5pt; color: #444; }
  p { margin: 0.4em 0; }
  table { width: 100%; border-collapse: collapse; margin: 0.6em 0; font-size: 9pt; page-break-inside: avoid; }
  th, td { border: 1px solid #ccc; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #e8f1f8; font-weight: 600; }
  tr:nth-child(even) td { background: #f8fafc; }
  code, pre { font-family: "SF Mono", Menlo, monospace; font-size: 8.5pt; }
  pre { background: #f4f4f4; padding: 10px; border-radius: 4px; white-space: pre-wrap; page-break-inside: avoid; }
  code { background: #f0f0f0; padding: 1px 4px; border-radius: 2px; }
  ul { margin: 0.3em 0 0.6em 1.2em; }
  li { margin: 0.2em 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1em 0; }
  strong { color: #111; }
</style>
</head>
<body>
${body}
</body>
</html>`;

writeFileSync(htmlPath, html);

const chromePaths = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

let chrome = chromePaths.find((p) => {
  try {
    execSync(`test -x "${p}"`);
    return true;
  } catch {
    return false;
  }
});

if (!chrome) {
  console.error('Chrome/Chromium/Edge not found for PDF export.');
  console.error('HTML written to:', htmlPath);
  process.exit(1);
}

execSync(
  `"${chrome}" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="${pdfPath}" "file://${htmlPath}"`,
  { stdio: 'inherit' }
);
console.log('PDF written to:', pdfPath);
