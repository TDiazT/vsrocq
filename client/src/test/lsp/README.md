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
  completes the initialize handshake, and exposes `openDocument`,
  `waitUntilChecked`, `sendConfiguration`, `shutdown`, plus the raw
  `connection` (a `vscode-languageserver-protocol` `ProtocolConnection`) for
  everything feature-specific. One process per test, not one shared server,
  so a test can't observe another test's state.
* `settings.ts`: the settings object sent as `initializationOptions`.
  `defaultSettings()` deviates from the extension's own defaults in two
  fields (`proof.mode: Continuous`, `proof.block: false`). See the
  docstring for why the readiness predicate below needs both.
* `golden.ts`: `expectGolden(name, actual)`, a deep-equal comparison against
  `golden/<name>.json`. `UPDATE_GOLDEN=1` rewrites the file in the working
  tree and never commits it. Read the diff before committing what it wrote.
  A regeneration that isn't read is a certificate for whatever the server
  happens to do today, including regressions.
* `fixtures/`: `.v` files purpose-built for this suite.
  `client/testFixture/` (used by `client/src/test/suite/`) is not reused.
* `golden/`: one `.json` file per golden case, added alongside each
  feature's test. Also `fixedArguments.ts`, which fixes what the servers in
  this directory are spawned with, and `fixedArguments.test.ts`, which checks
  that it is reaching them.
* `smoke.test.ts`: the one test that isn't feature-specific. It proves the
  harness itself works end to end.

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

## What this suite does not do

* It does not include a golden test for `definition`. The `Range`
  returned by `jump_to_definition` in `dm/queryManager.ml` is no longer
  inverted, but the golden test itself is a separate change.
* It does not depend on `vscode-jsonrpc` / `vscode-languageserver-protocol`
  / `vscode-uri` as declared dependencies. They are transitive dependencies
  of `vscode-languageclient`, already present in `client/node_modules/`, and
  importing them here does not touch `package.json` or the lockfile.
