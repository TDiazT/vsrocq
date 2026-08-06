# LSP black-box suite

Drives `vsrocqtop` directly over stdio and speaks LSP, instead of going
through VS Code. See `docs/adr/0001-protocol-level-test-safety-net.md` for
why this suite exists alongside (not instead of) `client/src/test/suite/`.

## Running

```sh
npm run test:lsp          # structural tests, version-independent, whole CI matrix
npm run test:lsp:golden   # golden tests, pinned to Rocq 9.2, one CI job
```

Both compile the client's TypeScript first (`pretest:lsp`,
`pretest:lsp:golden`). `VSROCQPATH` works the same as for `npm test` (see
`client/src/test/runTest.ts`); without it the harness falls back to
`language-server/_build/install/default/bin/vsrocqtop`.

`VSROCQARGS` is read by the structural tests only. The golden run ignores it
and spawns with a fixed argument set instead (`golden/fixedArguments.ts`,
loaded through mocha's `--require`), because a golden freezes the server's
answer verbatim and would otherwise freeze the ambient environment with it:
`install-opam` in `.github/workflows/ci.yml` exports `VSROCQARGS: -bt`, which
appends a ~20-frame Rocq backtrace to every error message. The structural
tests do inherit it, and need to — `dev-setup-opam` passes their server its
`-coqlib` that way.

## Layout

* `harness.ts`: `LspHarness`, which spawns one `vsrocqtop` process per test,
  completes the initialize handshake, and exposes `openDocument`, `applyEdit`,
  `waitUntilChecked`, `waitUntilRechecked`, `waitForDiagnostics`, `waitUntil`,
  `sendConfiguration`, `shutdown`, plus the raw `connection` (a
  `vscode-languageserver-protocol` `ProtocolConnection`) for everything
  feature-specific. One process per test, not one shared server, so a test
  can't observe another test's state. Also `compileFixture`, for the fixtures
  described below.

  **Do not call `connection.onNotification` for
  `prover/updateHighlights` or `textDocument/publishDiagnostics`.**
  `vscode-jsonrpc` keeps one handler per method, so registering one there
  silently replaces the harness's own: `waitUntilChecked` goes blind and times
  out reporting `last prover/updateHighlights: undefined`. The harness tracks
  both — use `onHighlights` to observe the highlight stream without displacing
  anything, and `latestDiagnostics` / `waitForDiagnostics` for diagnostics.
  Every other method is free.
* `settings.ts`: the settings object sent as `initializationOptions`.
  `defaultSettings()` deviates from the extension's own defaults in two
  fields (`proof.mode: Continuous`, `proof.block: false`). See the
  docstring for why the readiness predicate below needs both.
* `golden.ts`: `expectGolden(name, actual)`, a deep-equal comparison against
  `golden/<name>.json`. `UPDATE_GOLDEN=1` rewrites the file in the working
  tree and never commits it. Read the diff before committing what it wrote.
  A regeneration that isn't read is a certificate for whatever the server
  happens to do today, including regressions. Tests pass the response
  through untouched, with one exception: a response carrying an absolute
  path has to be made relative first, or the golden would freeze in place
  the directory this checkout lives in. See `golden/definition.test.ts`.
* `fixtures/`: `.v` files purpose-built for this suite.
  `client/testFixture/` (used by `client/src/test/suite/`) is not reused.
* `golden/`: one `.json` file per golden case, added alongside each
  feature's test. Also `fixedArguments.ts`, which fixes what the servers in
  this directory are spawned with, and `fixedArguments.test.ts`, which checks
  that it is reaching them.
* `smoke.test.ts`: the one test that isn't feature-specific. It proves the
  harness itself works end to end.
* `didChange.test.ts`: the edit cycle. Structural rather than golden: what it
  protects is that an edit is re-checked, that the diagnostic it introduces
  appears and the one it repairs goes away, and that the last
  `publishDiagnostics` reaches the client even when the document goes quiet
  right after the edit. None of that is the exact content of a response, and
  the post-edit diagnostics list is a bad thing to freeze anyway — the server
  does not order it positionally. Its third case is skipped: it characterizes
  V11, which is a server bug, and the fix belongs in its own commit.

Structural tests live directly under `lsp/`; golden tests live under
`lsp/golden/`. `npm run test:lsp` and `npm run test:lsp:golden` glob those
two locations separately, so which directory a test file lands in decides
whether it runs on the whole CI matrix or on the single pinned job.

## The readiness predicate

`waitUntilChecked` waits on `prover/updateHighlights`
(`preparedRange`/`processingRange`/`processedRange`) for:

```
preparedRange == [] && processingRange == [] &&
processedRange reaches the end of the document
```

This is **not** "all three ranges are empty". That is equally the state
before any work has started, and the permanent state in Manual mode.

The predicate is only correct when `proof.block` is `false`
(`defaultSettings` sets it). With `block: true`, checking legitimately stops
at the first error and `processedRange` never reaches the end of the
document. A test that turns `block` on will see `waitUntilChecked` time out
by design, not by bug.

### After an edit, use `waitUntilRechecked`

The predicate above is also only correct on a document that has not been
edited. `waitUntilChecked` returns *immediately* after a `didChange` and
reports success while the server is still recomputing — finding V11. The
`prover/updateHighlights` the server emits synchronously from
`textDocumentDidChange` carries the pre-edit overview, shifted for the edit
(`CheckingManager.shift_overview`) but not truncated at it, so
`processedRange` still spans the whole document while `preparedRange` and
`processingRange` are empty. Nothing in its contents distinguishes it from a
genuine completion.

What distinguishes it is *when* the server sends it: before it has scheduled
any parsing or checking. So `waitUntilRechecked` waits in two stages — first
for the server to report work in progress, which consumes the stale
notification, then for the readiness predicate. The ordering comes from the
server's control flow (`apply_text_edits`, then `update_view`, then the
returned events), not from timing.

Its first stage times out when the edit causes no work at all, on purpose: an
edit that triggers no re-checking gives a caller nothing to wait for, and
treating that as "re-checked" is how a test ends up asserting against the
pre-edit state. Verified by making the server discard the edit — both
edit-cycle tests fail there, on that stage, naming the stale `processedRange`.

### Waiting for diagnostics is not the same as waiting

Two measured traps, both of which make an obvious-looking wait vacuous:

* A document with no errors publishes `[]` from the first instant, so
  `d => d.length === 0` is satisfied before any work starts.
* After a `didChange`, the server publishes `[]` when it *invalidates* the
  edited sentences, ~20 ms before it finishes re-checking them. So the same
  predicate is satisfied on a document that had an error and may be about to
  have it again.

Waiting for the *absence* of a diagnostic only means something once checking
has been established to be over by other means. Asserting that an error is
gone is better done against a positive end state (`didChange.test.ts`'s
second test ends on two errors, not zero, for exactly this reason) or behind a
request whose answer depends on the new text.

## Fixtures that need a compiled library

Some requests only ever answer about names that come from a library on the
loadpath. `jump_to_definition` in `dm/queryManager.ml` is one: it returns a
location only for a `Loc.fname` of `InFile { dirpath = Some _ }`, and a name
defined in the buffer being edited is `ToplevelInput` instead, for which it
returns nothing. A fixture for one of those is a directory under `fixtures/`
holding the file the test opens, the file it requires, and a `_RocqProject`
declaring the loadpath. `vsrocqtop` reads that `_RocqProject` on `didOpen`,
walking up from the opened file's directory (`Args.get_local_args`, called
from `open_new_document`), so nothing in `harness.ts` has to know about it.

`compileFixture` in `harness.ts` builds the `.vo`, from a `before` hook. The
`.vo` is not committed: it is not portable across the Rocq versions CI
covers, and it has to be readable by the exact server under test, so the
compiler is taken from the directory `VSROCQPATH` points into whenever that
variable is set, and off `PATH` otherwise. Since it runs `rocq compile`
(Rocq 9.0 and later), only the version-pinned golden tests can use it.

The `.vo`, `.glob` and `.aux` files this leaves in `fixtures/` are covered by
`client/.gitignore`.

## What this suite does not do

* It does not depend on `vscode-jsonrpc` / `vscode-languageserver-protocol`
  / `vscode-uri` as declared dependencies. They are transitive dependencies
  of `vscode-languageclient`, already present in `client/node_modules/`, and
  importing them here does not touch `package.json` or the lockfile.
