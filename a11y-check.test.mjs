import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

test('tab-order warns when pages do not set /Tabs /S', async () => {
  const doc = await basePdf({ title: 'Report', lang: 'en-US' });
  const r = await checkAccessibility(await doc.save());
  assert.equal(statusOf(r, 'tab-order'), 'WARN');
  const fixed = await checkAccessibility(await (await cleanDoc()).save());
  assert.equal(statusOf(fixed, 'tab-order'), 'PASS');
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
