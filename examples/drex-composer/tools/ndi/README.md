# tools/ndi — building and checking the theory context pack

Everything here is plain Node 24 ESM with no dependencies. Run the commands from the project root.

| Script | Needs a key | What it does |
| --- | --- | --- |
| `build-text.mjs` | no | Raw downloads in `context-pack/books/<slug>/` → cleaned `text.txt` with a `[p. N]` line before each printed page. |
| `local-fallback.mjs` | no | Splits each `text.txt` by chapter heading → `context-pack/ndi/<slug>/chapters.json`. |
| `ingest.mjs` | yes (`NACE_API_KEY`), except `--dry-run` | The NDI pipeline: parse → split by chapter → classify by topic → extract rules → page references → `context-pack/digest.ndi.json`. |
| `check-digest.mjs` | no | Validates `digest.json` (or any digest file given as an argument) and the other JSON files of the pack. |
| `render-digest-md.mjs` | no | Writes `context-pack/digest.md` from `digest.json`. |
| `books.mjs` | — | Shared description of the four books: raw files, NDI source, table of contents. |

## The curated digest

`context-pack/digest.json` was written by reading the books and is the pack the composer uses today.
After editing it:

```bash
node tools/ndi/check-digest.mjs        # fields, topics, calls, <= 35 words, unique ids, counts
node tools/ndi/render-digest-md.mjs    # refresh digest.md
```

The checker also verifies `context-pack/digest.evidence.json`: for every sourced rule it holds one
sentence copied from the book, and the checker confirms that sentence is in `text.txt` on the page
the rule cites. If you add a sourced rule, add its evidence quote too. Rules with `"source": null`
must carry `"own": true` and must stay under 25% of the digest.

## Offline chapter split

```bash
node tools/ndi/build-text.mjs          # only after changing the raw files or the cleaner
node tools/ndi/local-fallback.mjs      # all four books
node tools/ndi/local-fallback.mjs --book prout-form
```

Each chapter in `chapters.json` has its printed page range, its page range in the scan PDF
(`pdf_start_page`, `pdf_end_page`), its line range in `text.txt`, and either the numbered paragraphs
it contains with the page each starts on (`paragraph_pages`, for Goetschius, Tchaikovsky and Prout)
or its headed sections (Rimsky-Korsakov). The file says `"producedBy": "local-fallback"`.

## The NDI ingester

```bash
node tools/ndi/ingest.mjs --all --dry-run                     # print the requests; no key, writes nothing
NACE_API_KEY=nace_sk_... node tools/ndi/ingest.mjs --book goetschius-melody --limit 3   # cheap first trial
NACE_API_KEY=nace_sk_... node tools/ndi/ingest.mjs --all
node tools/ndi/check-digest.mjs context-pack/digest.ndi.json
```

**It has never been run against the live API.** No key existed when it was written. It was exercised
only with `--dry-run` and against a local stand-in server that answers in the documented shapes, so
expect to adjust it on the first real run. Start with one book and `--limit 3`.

Steps, per book (`--steps` runs a subset):

1. **upload**: `POST /v1/documents/upload-grants`, then a multipart `POST` to the returned
   `upload_url` with `X-Upload-Token`. The three scans go up as PDFs. Rimsky-Korsakov has no scan,
   so its `text.txt` is uploaded instead. `--source url` skips the upload and lets NDI fetch the PDF
   from archive.org.
2. **parse**: `POST /v1/documents/parse` with Markdown and blocks, page markers on, figures omitted
   → `parse.json`.
3. **split**: `POST /v1/documents/split` on the parse, with one `chapter` class, an `instance_key`
   for the chapter heading and `split_rules` → `chapters.json` (`"producedBy": "ndi-split"`). If
   Split finds fewer than 60% of the chapters in the book's table of contents, its answer is kept as
   `chapters.ndi-split.json` and the local split is used. A text book, or `--chapters local`, always
   uses the local split.
4. **classify**: `POST /v1/documents/classify` once per unit (a chapter, cut into windows of
   `--window` pages, default 12), against the eleven digest topics. Topics are written back into
   `chapters.json`.
5. **extract**: `POST /v1/documents/extract` once per unit that has a topic, with a JSON schema for
   up to 12 rules (`text`, `topic`, `section`, `calls`) and citations on → `rules.json`. Each rule's
   citation is turned into a printed page number; a rule is dropped (and listed under `dropped`)
   if it is over 35 words, has an invalid topic, or cannot be tied to a page.
6. **merge**: all `rules.json` files → `context-pack/digest.ndi.json`, in the same schema as
   `digest.json`, so it can be diffed against it or replace it.

Behaviour worth knowing:

- **Resumable.** `state.json` in each book's folder records the uploaded file and every job id, and
  a step whose output exists is skipped. Re-run the same command after a failure. `--force` redoes
  steps and sends fresh idempotency keys.
- **Retries.** `408`, `429` and `5xx` answers are retried up to five times, waiting the number of
  seconds in `Retry-After` when the header is present, otherwise backing off exponentially. An error
  the API marks `retryable: false` is not retried. Every create carries an `Idempotency-Key` built
  from the book, step, unit and a hash of the body, so a retry cannot bill twice.
- **Cost.** One parse per book, one split per scanned book, then two jobs per unit: 34 units for
  Goetschius, 35 for Tchaikovsky, 27 for Prout and 12 for Rimsky-Korsakov with the local chapter
  split and the default window. `--parse-mode high`
  doubles the parse price.
- **Missing key.** Without `NACE_API_KEY` (and without `--dry-run`) it exits with status 1 and says
  what to run instead.

### Where the docs do not settle the behaviour

Each of these is marked `// DOCS-UNVERIFIED:` in `ingest.mjs`. Check them on the first real run.

1. **Upload answer.** Whether the job a one-request upload answers with can still be queued. The
   code polls it if `result.file` is not there yet.
2. **Page markers.** Whether `--- Page N ---` names the page after the marker (assumed) or before
   it, and whether page 1 gets one.
3. **Plain text through Parse.** Whether Parse returns a `.txt` file's lines unchanged, so the
   `[p. N]` markers and `## Chapter` headings survive (Rimsky-Korsakov). If they do not, the local
   `text.txt` is used for the chapter split.
4. **Split used on chapters.** Split is documented for packets of separate documents. Cutting one
   book at its chapter headings with a single class, an `instance_key` and `split_rules` is our
   reading of those options.
5. **Split page numbers.** That `start_page`/`end_page` of a split run on a `parse_result` source
   are pages of the original PDF.
6. **`page_ranges` with a `parse_result` source.** The Sources table says Split, Classify and
   Extract accept it; the Extract page's Pages section is headed "Not with a `parse_result`
   source". On a `422` the code retries on the uploaded file with the same pages, which parses
   those pages again and is billed for it.
7. **Several topics from Classify.** The docs describe runner-up labels but not how to read them as
   "this passage covers several topics". The code keeps the winner and any runner-up at 0.15
   confidence or more.
8. **Extract `fields` paths.** `/rules/0`, `/rules/1`… are documented for a top-level array;
   whether properties inside each item (`/rules/0/text`) get their own entries is not. Citations
   are collected from both.
9. **Citations on a text source.** `text_span` offsets are "into the derived text"; the code
   assumes that is the uploaded file and uses the offset only when the quoted `source_text` cannot
   be found in it.

One more thing is not a shape question but a capability one: Extract is described as filling a
schema from a document, and here it is asked to rewrite each rule as one imperative sentence of at
most 35 words. How well it paraphrases is unknown until it runs. Rules over the limit are dropped at
merge, not shortened.
