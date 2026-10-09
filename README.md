# a11y-check

**A fast accessibility pre-flight for PDFs, built for CI.**

Most inaccessible PDFs fail for the same few reasons: no tags, no language, no title, figures without alt text, and focus order that ignores the structure. a11y-check finds those in milliseconds, gives you a Markdown report, and fails the build when a document regresses.

It is a **pre-flight, not a conformance test.** Passing it does not mean the file is PDF/UA compliant. For that, run [veraPDF](https://verapdf.org/) and a human review.

## What it checks

| Check | Passes when | Fails when |
| --- | --- | --- |
| `tagged` | A structure tree exists and the document is marked as tagged | No structure tree, or not marked |
| `language` | The catalog declares a BCP 47 `/Lang` such as `en-US` | Missing `/Lang` (fails); malformed tag like `english` (warns) |
| `title` | The metadata has a real title and the viewer shows it | No title (fails); generic title like `Untitled` (warns); `DisplayDocTitle` off (warns) |
| `figures` | Every `Figure` element has descriptive `/Alt` text | Any figure without alt text (fails); alt that looks like a file name or placeholder such as `image1.png` (warns); no figures at all (warns) |
| `tab-order` | Every page sets `/Tabs /S` | Some pages do not (warning) |

## Install

```bash
npm install
```

Requires Node 20+. The only dependency is `pdf-lib`.

## Usage

```bash
node a11y-check.mjs examples/sample-untagged.pdf
node a11y-check.mjs docs/*.pdf --md report.md --json report.json --fail-on warn
```

```
examples/sample-untagged.pdf
  FAIL tagged     no structure tree or not marked as tagged
  FAIL language   no /Lang set on the document catalog
  FAIL title      no document title in metadata
  WARN figures    no Figure elements found (no tagged images, or none on the page)
  WARN tab-order  1 of 1 page(s) do not set /Tabs /S (focus order may not follow structure)
  1 page(s): 0 pass, 2 warn, 3 fail
```

A sample Markdown report is in [`examples/sample-report.md`](examples/sample-report.md).

| Exit | Meaning |
| --- | --- |
| `0` | Clean (warnings allowed unless `--fail-on warn`) |
| `1` | A failure, or a warning with `--fail-on warn` |
| `2` | Unreadable input or bad usage |

## CI

`.github/workflows/a11y-check.yml` runs on every pull request, checks `docs/*.pdf`, and writes the report to the job summary.

## Limits

- Tag quality is not checked. A structure tree can exist and still have the wrong reading order.
- Figure detection depends on the document tagging figures as `Figure`.
- Encrypted files are loaded with `ignoreEncryption: false`, so they will fail to open unless they are unencrypted.
- Scanned PDFs without OCR have no text to check.
- Placeholder detection is pattern-based. Alt text such as "Bar chart of Q3 sales" passes; a short, vague phrase that is not on the pattern list will also pass, so a human still reads the alt text.

## License

MIT
