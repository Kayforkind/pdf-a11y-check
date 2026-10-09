#!/usr/bin/env node
/**
 * a11y-check — a fast accessibility pre-flight for PDFs.
 *
 * Checks that fail most often in real documents:
 *  - tagged:    a structure tree exists and the document is marked as tagged
 *  - language:  the catalog declares /Lang
 *  - title:     the document has a title, and the viewer is set to show it
 *  - figures:   every Figure element has alternate text (/Alt)
 *  - tab-order: every page sets /Tabs /S so keyboard focus follows structure
 *
 * Heuristic, not a PDF/UA conformance validator. Passing these does not prove
 * PDF/UA compliance. Run veraPDF and a manual review before claiming conformance.
 *
 * Usage:
 *   a11y-check file.pdf [more.pdf ...] [--json out.json] [--md out.md] [--fail-on fail|warn]
 * Exit: 0 clean · 1 failure (or warning with --fail-on warn) · 2 unreadable input
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';

export async function checkAccessibility(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const ctx = doc.context;
  const catalog = doc.catalog;
  const resolve = (x) => (x instanceof PDFRef ? ctx.lookup(x) : x);
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });

  // 1. tagged
  const root = resolve(catalog.get(PDFName.of('StructTreeRoot')));
  const markInfo = resolve(catalog.get(PDFName.of('MarkInfo')));
  const marked = markInfo instanceof PDFDict && resolve(markInfo.get(PDFName.of('Marked')))?.toString() === 'true';
  if (root instanceof PDFDict && marked) add('tagged', 'PASS', 'structure tree present and marked');
  else add('tagged', 'FAIL', 'no structure tree or not marked as tagged');

  // 2. language
  const lang = resolve(catalog.get(PDFName.of('Lang')));
  const langText = lang?.decodeText ? lang.decodeText() : lang ? String(lang) : '';
  if (langText) add('language', 'PASS', `document language "${langText}"`);
  else add('language', 'FAIL', 'no /Lang set on the document catalog');

  // 3. title
  const title = doc.getTitle();
  const prefs = resolve(catalog.get(PDFName.of('ViewerPreferences')));
  const showTitle = prefs instanceof PDFDict && resolve(prefs.get(PDFName.of('DisplayDocTitle')))?.toString() === 'true';
  if (!title) add('title', 'FAIL', 'no document title in metadata');
  else if (!showTitle) add('title', 'WARN', `title "${title}" set but DisplayDocTitle is not enabled`);
  else add('title', 'PASS', `title "${title}" shown in the viewer`);

  // 4. figures
  const figures = [];
  const walk = (node, depth = 0) => {
    if (depth > 200) return;
    const obj = resolve(node);
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) walk(obj.get(i), depth + 1);
    } else if (obj instanceof PDFDict) {
      const s = resolve(obj.get(PDFName.of('S')));
      if (s && s.toString() === '/Figure') figures.push(obj);
      walk(obj.get(PDFName.of('K')), depth + 1);
    }
  };
  if (root instanceof PDFDict) walk(root.get(PDFName.of('K')));
  const missingAlt = figures.filter((f) => {
    const alt = resolve(f.get(PDFName.of('Alt')));
    return !(alt && alt.decodeText && alt.decodeText().trim());
  });
  if (figures.length === 0) add('figures', 'WARN', 'no Figure elements found (no tagged images, or none on the page)');
  else if (missingAlt.length) add('figures', 'FAIL', `${missingAlt.length} of ${figures.length} figure(s) have no alternate text`);
  else add('figures', 'PASS', `all ${figures.length} figure(s) have alternate text`);

  // 5. tab order: keyboard focus should follow the structure, which needs /Tabs /S per page
  const pages = doc.getPages();
  const noTabs = pages.filter((p) => resolve(p.node.get(PDFName.of('Tabs')))?.toString() !== '/S').length;
  if (noTabs === 0) add('tab-order', 'PASS', `all ${pages.length} page(s) set /Tabs /S`);
  else add('tab-order', 'WARN', `${noTabs} of ${pages.length} page(s) do not set /Tabs /S (focus order may not follow structure)`);

  const count = (s) => checks.filter((c) => c.status === s).length;
  return {
    pages: pages.length,
    summary: { PASS: count('PASS'), WARN: count('WARN'), FAIL: count('FAIL') },
    checks,
  };
}

export function toMarkdown(results) {
  const lines = ['# PDF accessibility pre-flight', ''];
  for (const { file, report } of results) {
    lines.push(`## ${file}`, '', `${report.pages} page(s) · ${report.summary.PASS} pass · ${report.summary.WARN} warn · ${report.summary.FAIL} fail`, '');
    lines.push('| Check | Status | Detail |', '| --- | --- | --- |');
    for (const c of report.checks) lines.push(`| ${c.id} | ${c.status} | ${c.detail.replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  lines.push('_Heuristic pre-flight, not a PDF/UA conformance report._', '');
  return lines.join('\n');
}

function setExit(code) {
  // Set, do not force-exit (see api-watch: forced exit can trip a libuv assertion on Windows).
  process.exitCode = code;
  return code;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'string' },
      md: { type: 'string' },
      'fail-on': { type: 'string', default: 'fail' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log('usage: a11y-check file.pdf [more.pdf ...] [--json out.json] [--md out.md] [--fail-on fail|warn]');
    return setExit(values.help ? 0 : 2);
  }
  if (!['fail', 'warn'].includes(values['fail-on'])) {
    console.error('--fail-on must be "fail" or "warn"');
    return setExit(2);
  }
  const results = [];
  for (const file of positionals) {
    try {
      results.push({ file, report: await checkAccessibility(new Uint8Array(readFileSync(file))) });
    } catch (e) {
      console.error(`cannot read ${file}: ${e.message}`);
      return setExit(2);
    }
  }
  if (values.json) {
    const payload = results.length === 1 ? results[0].report : results;
    writeFileSync(values.json, JSON.stringify(payload, null, 2) + '\n');
  }
  if (values.md) writeFileSync(values.md, toMarkdown(results));
  for (const { file, report } of results) {
    console.log(`\n${file}`);
    for (const c of report.checks) console.log(`  ${c.status.padEnd(4)} ${c.id.padEnd(10)} ${c.detail}`);
    console.log(`  ${report.pages} page(s): ${report.summary.PASS} pass, ${report.summary.WARN} warn, ${report.summary.FAIL} fail`);
  }
  const fail = results.some((r) => r.report.summary.FAIL > 0);
  const warn = results.some((r) => r.report.summary.WARN > 0);
  return setExit(fail || (values['fail-on'] === 'warn' && warn) ? 1 : 0);
}

if (process.argv[1]?.endsWith('a11y-check.mjs')) {
  main(process.argv.slice(2));
}
