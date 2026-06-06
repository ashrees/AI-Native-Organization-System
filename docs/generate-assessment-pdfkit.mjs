/**
 * Generate assessment PDF using PDFKit (no browser required).
 */
import PDFDocument from 'pdfkit';
import { createWriteStream, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mdPath = join(__dirname, 'project-scalability-reliability-assessment.md');
const pdfPath = join(__dirname, 'project-scalability-reliability-assessment.pdf');

const md = readFileSync(mdPath, 'utf8');
const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
const stream = createWriteStream(pdfPath);
doc.pipe(stream);

const PAGE_W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
let y = doc.page.margins.top;

function needPage(h = 40) {
  if (y + h > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }
}

function heading(text, size, color = '#0d3b66') {
  needPage(size + 20);
  doc.font('Helvetica-Bold').fontSize(size).fillColor(color).text(text, doc.page.margins.left, y, {
    width: PAGE_W,
  });
  y = doc.y + 8;
}

function para(text, opts = {}) {
  const size = opts.size || 10;
  needPage(30);
  doc
    .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(size)
    .fillColor(opts.color || '#1a1a1a')
    .text(text.replace(/\*\*/g, ''), doc.page.margins.left, y, { width: PAGE_W, lineGap: 2 });
  y = doc.y + 6;
}

function table(rows) {
  if (!rows.length) return;
  const cols = rows[0].length;
  const colW = PAGE_W / cols;
  const rowH = 18;
  const fontSize = 8;

  for (let r = 0; r < rows.length; r++) {
    needPage(rowH + 4);
    const isHeader = r === 0;
    let x = doc.page.margins.left;
    for (let c = 0; c < cols; c++) {
      if (isHeader) {
        doc.rect(x, y, colW, rowH).fill('#e8f1f8');
        doc.fillColor('#145374');
        doc.font('Helvetica-Bold').fontSize(fontSize);
      } else {
        doc.rect(x, y, colW, rowH).stroke('#dddddd');
        doc.fillColor('#1a1a1a');
        doc.font('Helvetica').fontSize(fontSize);
      }
      const cell = String(rows[r][c] || '').replace(/\*\*/g, '').slice(0, 80);
      doc.text(cell, x + 4, y + 4, { width: colW - 8, height: rowH - 6, ellipsis: true });
      x += colW;
    }
    y += rowH;
  }
  y += 8;
}

function codeBlock(text) {
  const lines = text.split('\n');
  const h = lines.length * 11 + 16;
  needPage(h);
  doc.rect(doc.page.margins.left, y, PAGE_W, h).fill('#f4f4f4');
  doc.font('Courier').fontSize(8).fillColor('#333');
  doc.text(text, doc.page.margins.left + 8, y + 8, { width: PAGE_W - 16 });
  y += h + 8;
}

const lines = md.split('\n');
let i = 0;
let inCode = false;
let codeBuf = [];

while (i < lines.length) {
  const line = lines[i];
  const trim = line.trim();

  if (trim.startsWith('```')) {
    if (inCode) {
      codeBlock(codeBuf.join('\n'));
      codeBuf = [];
      inCode = false;
    } else {
      inCode = true;
    }
    i += 1;
    continue;
  }
  if (inCode) {
    codeBuf.push(line);
    i += 1;
    continue;
  }

  if (trim.startsWith('|') && trim.endsWith('|')) {
    const tableRows = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      const row = lines[i]
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (!row.every((c) => /^[-:]+$/.test(c))) tableRows.push(row);
      i += 1;
    }
    table(tableRows);
    continue;
  }

  if (trim.startsWith('# ')) {
    heading(trim.slice(2), 18);
  } else if (trim.startsWith('## ')) {
    heading(trim.slice(3), 14);
  } else if (trim.startsWith('### ')) {
    heading(trim.slice(4), 12, '#145374');
  } else if (trim.startsWith('#### ')) {
    heading(trim.slice(5), 11, '#333333');
  } else if (trim === '---') {
    needPage(12);
    doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + PAGE_W, y).stroke('#cccccc');
    y += 12;
  } else if (trim.startsWith('- ')) {
    para(`• ${trim.slice(2)}`, { size: 10 });
  } else if (trim === '') {
    y += 4;
  } else {
    para(trim);
  }
  i += 1;
}

doc.end();

stream.on('finish', () => {
  console.log('PDF written to:', pdfPath);
});
