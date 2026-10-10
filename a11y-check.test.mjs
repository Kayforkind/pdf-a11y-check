import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString, PDFBool, StandardFonts } from 'pdf-lib';
import { checkAccessibility, toMarkdown } from './a11y-check.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'a11y-check.mjs');

async function basePdf({ title, lang } = {}) {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText('Hello', { x: 20, y: 250, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  if (title) doc.setTitle(title);
  if (lang) doc.catalog.set(PDFName.of('Lang'), PDFString.of(lang));
  return doc;
}

/** Adds a structure tree with one Figure element, optionally with /Alt text. */
function tagWithFigure(doc, { alt } = {}) {
  const ctx = doc.context;
  const figure = ctx.obj({ Type: 'StructElem', S: 'Figure', K: 0 });
  if (alt !== undefined) figure.set(PDFName.of('Alt'), PDFString.of(alt));
  const figRef = ctx.register(figure);
  const root = ctx.obj({ Type: 'StructTreeRoot', K: ctx.obj([figRef]) });
  doc.catalog.set(PDFName.of('StructTreeRoot'), ctx.register(root));
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: PDFBool.True }));
  doc.catalog.set(PDFName.of('ViewerPreferences'), ctx.obj({ DisplayDocTitle: PDFBool.True }));
}

const setTabs = (doc) => doc.getPages().forEach((p) => p.node.set(PDFName.of('Tabs'), PDFName.of('S')));
const statusOf = (r, id) => r.checks.find((c) => c.id === id).status;

async function cleanDoc() {
  const doc = await basePdf({ title: 'Report', lang: 'en-US' });
  tagWithFigure(doc, { alt: 'Bar chart of Q3 sales' });
  setTabs(doc);
  return doc;
}

test('an untagged PDF with no title or language fails tagged, language and title', async () => {
  const r = await checkAccessibility(await (await basePdf()).save());
  assert.equal(statusOf(r, 'tagged'), 'FAIL');
  assert.equal(statusOf(r, 'language'), 'FAIL');
  assert.equal(statusOf(r, 'title'), 'FAIL');
  assert.equal(statusOf(r, 'figures'), 'WARN');
});

test('a tagged figure without alt text fails the figures check', async () => {
  const doc = await basePdf({ title: 'Report', lang: 'en-US' });
  tagWithFigure(doc);
  const r = await checkAccessibility(await doc.save());
  assert.equal(statusOf(r, 'tagged'), 'PASS');
  assert.equal(statusOf(r, 'language'), 'PASS');
  assert.equal(statusOf(r, 'title'), 'PASS');
  assert.equal(statusOf(r, 'figures'), 'FAIL');
  assert.match(r.checks.find((c) => c.id === 'figures').detail, /1 of 1 figure\(s\) have no alternate text/);
});

test('a tagged figure with alt text passes every check', async () => {
  const r = await checkAccessibility(await (await cleanDoc()).save());
  assert.equal(r.summary.FAIL, 0);
  assert.equal(r.summary.WARN, 0);
  assert.equal(statusOf(r, 'figures'), 'PASS');
});

test('a malformed language tag is a warning, not a pass', async () => {
  const r = await checkAccessibility(await (await basePdf({ title: 'Report', lang: 'english' })).save());
  assert.equal(statusOf(r, 'language'), 'WARN');
  assert.match(r.checks.find((c) => c.id === 'language').detail, /not a BCP 47 tag/);
});

test('a generic title such as "Untitled" is flagged as a placeholder', async () => {
  const r = await checkAccessibility(await (await basePdf({ title: 'Untitled', lang: 'en-US' })).save());
  assert.equal(statusOf(r, 'title'), 'WARN');
  assert.match(r.checks.find((c) => c.id === 'title').detail, /generic placeholder/);
});

test('placeholder alt text such as a file name is flagged, and descriptive alt is not', async () => {
  const placeholder = await basePdf({ title: 'Report', lang: 'en-US' });
  tagWithFigure(placeholder, { alt: 'image1.png' });
  const r1 = await checkAccessibility(await placeholder.save());
  assert.equal(statusOf(r1, 'figures'), 'WARN');
  assert.match(r1.checks.find((c) => c.id === 'figures').detail, /placeholder-looking alt text/);

  const good = await basePdf({ title: 'Report', lang: 'en-US' });
  tagWithFigure(good, { alt: 'Bar chart of Q3 sales' });
  assert.equal(statusOf(await checkAccessibility(await good.save()), 'figures'), 'PASS');
});

test('CLI: a missing file or unknown flag exits 2 with a one-line message, not a stack trace', () => {
  const missing = spawnSync(process.execPath, [CLI, join(tmpdir(), 'no-such-file-xyz.pdf')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read/);
  assert.ok(!missing.stderr.includes('    at '));
  const bogus = spawnSync(process.execPath, [CLI, '--bogus'], { encoding: 'utf8' });
  assert.equal(bogus.status, 2);
  assert.ok(!bogus.stderr.includes('    at '));
});

test('CLI: a tagged, titled, sourced PDF passes with exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-'));
  const doc = await basePdf({ title: 'Quarterly report', lang: 'en-US' });
  doc.getPage(0).node.set(PDFName.of('Tabs'), PDFName.of('S'));
  tagWithFigure(doc, { alt: 'Bar chart of Q3 sales' });
  const file = join(dir, 'ok.pdf');
  writeFileSync(file, await doc.save());
  const r = spawnSync(process.execPath, [CLI, file, '--fail-on', 'warn'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('tab-order warns when pages do not set /Tabs /S', async () => {
  const doc = await basePdf({ title: 'Report', lang: 'en-US' });
  const r = await checkAccessibility(await doc.save());
  assert.equal(statusOf(r, 'tab-order'), 'WARN');
  const fixed = await checkAccessibility(await (await cleanDoc()).save());
  assert.equal(statusOf(fixed, 'tab-order'), 'PASS');
});

test('cyclic structure trees and oversized PDFs fail closed', async () => {
  const doc = await basePdf();
  const root = doc.context.obj({ Type: 'StructTreeRoot' });
  const ref = doc.context.register(root);
  root.set(PDFName.of('K'), ref);
  doc.catalog.set(PDFName.of('StructTreeRoot'), ref);
  await assert.rejects(checkAccessibility(await doc.save()), /cyclic/);
  await assert.rejects(checkAccessibility(new Uint8Array(25 * 1024 * 1024 + 1)), /25 MiB/);
});

test('report escapes malicious PDF metadata and CLI refuses input overwrite', async () => {
  const doc = await basePdf({ title: '<img src=x onerror=alert(1)>', lang: 'en' });
  const report = await checkAccessibility(await doc.save());
  const markdown = toMarkdown([{ file: '<script>x</script>.pdf', report }]);
  assert.ok(!markdown.includes('<img') && !markdown.includes('<script>'));
  const root = mkdtempSync(join(tmpdir(), 'a11y-sec-'));
  const file = join(root, 'x.pdf');
  writeFileSync(file, await doc.save());
  assert.equal(spawnSync(process.execPath, [CLI, file, '--md', file]).status, 2);
});

test('markdown report lists every check with escaped details', async () => {
  const r = await checkAccessibility(await (await basePdf()).save());
  const md = toMarkdown([{ file: 'x.pdf', report: r }]);
  assert.match(md, /## x\.pdf/);
  assert.match(md, /\| tagged \| FAIL \|/);
  assert.match(md, /Heuristic pre-flight/);
});

test('CLI: exit 0 for a clean file, 1 for failures, 1 for warnings under --fail-on warn, 2 for unreadable input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-'));
  const clean = join(dir, 'clean.pdf');
  const dirty = join(dir, 'dirty.pdf');
  const warnOnly = join(dir, 'warn.pdf');
  writeFileSync(clean, await (await cleanDoc()).save());
  writeFileSync(dirty, await (await basePdf()).save());
  const w = await basePdf({ title: 'T', lang: 'en' });
  tagWithFigure(w, { alt: 'ok' }); // tabs unset -> WARN only
  writeFileSync(warnOnly, await w.save());

  const code = async (args) => {
    try {
      await run(process.execPath, [CLI, ...args], { encoding: 'utf8' });
      return 0;
    } catch (e) {
      return e.code;
    }
  };
  assert.equal(await code([clean]), 0);
  assert.equal(await code([dirty]), 1);
  assert.equal(await code([warnOnly]), 0);
  assert.equal(await code([warnOnly, '--fail-on', 'warn']), 1);
  assert.equal(await code([join(dir, 'missing.pdf')]), 2);
});
