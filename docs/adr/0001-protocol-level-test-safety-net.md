# ADR-0001: The characterization safety net is anchored at the LSP wire, not inside VS Code

**Status:** accepted
**Date:** 2026-08-04

### Findings referenced here and in the suite

A survey of the server's protocol behaviour preceded this work; its findings are
numbered `V<n>` and the code refers to them by those numbers. The ones this
document and `client/src/test/lsp/` depend on:

| | |
|---|---|
| **V3** | `textDocument/definition` returns an inverted `Range` (`start` > `end`) |
| **V5** | `prover/updateHighlights` is a usable readiness signal, but "all ranges empty" is both the initial and the terminal state |
| **V6** | Two harness requirements not visible from the client code: `prover/proofView` has no request form, and `proof.block` gates whether checking reaches the end of a document with an error in it |
| **V8** | `proof.delegation: "Delegate"` does not complete: no diagnostics, and checking never settles |
| **V11** | After a `didChange` in Continuous mode, the next `prover/updateHighlights` reports the pre-edit `processedRange` as complete |

Each is described where it is used below; the numbers are kept because the tests
cite them.

## Context

VsRocq has two test suites and neither observes the LSP protocol.

- `language-server/tests/*.ml` — 72 `ppx_inline_test` cases that call OCaml
  functions directly (`DocumentManager.interpret_to_end`). No JSON is ever
  produced.
- `client/src/test/suite/*.test.ts` — Mocha inside a real VS Code launched by
  `@vscode/test-electron`. It observes `vscode` API objects, i.e. the result of
  the extension having already translated the protocol.

Nothing tests the wire between them. Adding a characterization ("golden") layer
required deciding which of the two to build on, or whether to add a third.

Four measurements made during that decision:

1. **`textDocument/definition` returns an inverted `Range`** (`start` > `end`,
   V3). VS Code's `Range` constructor is documented to swap the two values when
   `start` does not precede `end`, so the client repairs the defect before any
   assertion can see it. The bug is *structurally* invisible from a test running
   inside VS Code, and visible in one line of raw JSON.

2. **The three `proof.delegation` modes are trivially distinguishable at the
   wire** — 2, 1 and 0 diagnostics respectively on the same fixture (V8) — and
   `Delegate` never settles. Neither existing suite notices: the client tests
   assert a final state that is identical across modes, and
   `em_tests.ml`'s helper treats a stalled event loop and a finished one as the
   same outcome (`Sel.pop_timeout ~stop_after_being_idle_for:0.3` returns the
   state on timeout rather than failing).

3. **`prover/proofView` has no request form** (V6). Goals are pushed as a server
   notification which the extension forwards into a webview's internal state.
   No `vscode` API can read it, so goals cannot be characterized from the
   Electron suite without modifying `extension.ts` to export its
   `LanguageClient` — a production change made solely for tests.

4. **The Electron suite is not deterministic enough to freeze snapshots
   against**, by its own record: `feedback_skip.test.ts:29-32` carries a
   commented-out count assertion annotated "on some setups diagnostics from a
   leftover tab are somehow here, but on other setups they are not". A golden
   test is exactly a full-response assertion; an environment where the *count*
   could not be asserted will not sustain one.

## Decision

**A new black-box suite drives `vsrocqtop` over stdio and speaks LSP directly.
Golden tests live there. The existing suites are kept and repaired, not
replaced.**

| | |
|---|---|
| Location | `client/src/test/lsp/`, inside the existing npm project |
| Runner | plain Mocha via `npm run test:lsp` — no Electron, no new dependency |
| Protocol plumbing | `vscode-jsonrpc` / `vscode-languageserver-protocol`, already present as transitive dependencies of `vscode-languageclient` |
| Server lifecycle | one `vsrocqtop` process per test (measured: ~0.1 s to spawn, initialize, open and fully check an 8-line file) |
| Default mode | `proof.mode: Continuous`; `Manual` reachable per-test via `workspace/didChangeConfiguration`, which retracts open documents to unchecked (`lspManager.ml`'s `reset_observe_ids`) |
| Golden format | one explicit `.json` file per case, deep-equal compared; `UPDATE_GOLDEN=1` rewrites them into the working tree and never commits |
| Golden scope | pinned to Rocq 9.2, run by one CI job (`npm run test:lsp:golden`); the version-independent part of the suite runs on the whole matrix |
| Fixtures | purpose-built, under the new suite; `client/testFixture/` is not reused |

### Readiness

All waiting in the new suite is derived from measurement (V5, V11) rather than
from silence. On a document that has not been edited, one predicate:

```
preparedRange == [] && processingRange == [] &&
processedRange reaches the end of the document
```

This holds only under `proof.block: false`; with `block: true` checking
legitimately stops at the first error and never reaches the end. The invariant
is stated wherever the harness is documented, because it couples a user-facing
setting to the correctness of a wait condition.

"All three ranges empty" is *not* the predicate: it is equally the state before
any work starts, and the permanent state in Manual mode.

### Readiness after an edit

**Amended 2026-08-06, when the edit-cycle tests were added; V11 fixed
2026-08-07.** That predicate *was* a false positive after a `didChange`, and
the suite waits in two stages, which is what surfaced the bug and now guards
against its return.

The `prover/updateHighlights` the server emits synchronously from
`textDocumentDidChange` carried the pre-edit overview, shifted for the new text
(`CheckingManager.shift_overview`) but not truncated at the edit, so
`processedRange` still spanned the whole document while the other two lists were
empty. It satisfied the predicate above while the server had not begun
re-checking (V11). Nothing in its *contents* distinguished it from a genuine
completion; what did was its position in the sequence, since the server sends it
before scheduling any parsing or checking.

So `LspHarness.waitUntilRechecked` waits first for the server to report work in
progress — which consumed the stale notification — and only then for the
predicate. The ordering comes from the server's control flow
(`apply_text_edits`, then `update_view`, then the returned events), so this is
a guarantee, not a race won by margin. Its first stage times out when an edit
causes no work at all, deliberately: an edit that triggers no re-check gives a
caller nothing to wait for, and treating that as "re-checked" is how a test
ends up asserting against the pre-edit state.

Two alternatives were rejected. **Sleeping** past the window: the window is not
bounded — it was over 60 seconds on a 20.750-sentence document — and the suite
runs on the whole CI matrix. **An out-of-band check** (watching CPU, per V11's
original recommendation): unavailable to a test that only speaks LSP, and
unnecessary once the ordering above is used.

**Fixing V11 first** was rejected for the test commit and done in the next one:
`CheckingManager.truncate_overview`, called from `apply_text_edits`, drops from
all three lists everything at or after the edit, so the first notification
reports the document as checked up to the edit rather than to its end. The
characterizing test was written against the bug, verified red, and unskipped by
the fix. Splitting it that way was deliberate — the tests had to be able to
fail against the server as it was, or there would be no evidence they test
anything.

## Alternatives considered

**Build the golden layer on the Electron suite.** Rejected. Four of the six
target features (diagnostics, hover, definition, completion, documentSymbol)
are reachable through `vscode` APIs, so this was not obviously wrong — but
goals are not reachable at all, the two measured defects above are invisible or
unassertable there, and the environment's own comments document
non-determinism.

**Export the `LanguageClient` from `activate()`** so Electron tests can observe
`prover/*` traffic and use the strong readiness signal. Rejected for this work:
it changes production code for the benefit of tests, and the new suite already
provides the capability.

**Write the driver in OCaml or Python.** Rejected. OCaml has no LSP client at
hand — `Content-Length` framing and request/response correlation would be
hand-rolled — and `ppx_inline_test` is a poor fit for driving a subprocess.
Python would add a language the repository does not use; a
throwaway Python LSP driver written earlier to reproduce a performance issue
served as a reference implementation rather than as the basis.

**A separate top-level `test/server/`**, mirroring the one in rocq-lsp
(`rocq-community/rocq-lsp`). Rejected
on cost: it duplicates devDependencies and adds a second `node_modules` install
to every CI job, whereas `client/` is already installed and already resolves the
server binary path with a `VSROCQPATH` override (`client/src/test/runTest.ts`).

**Per-Rocq-version golden sets.** Rejected: eight sets cannot be generated here,
and regenerating them would fall on maintainers at every Rocq bump.

**Structurally normalized, version-independent goldens.** Rejected as the
primary form: for hover and goals the content *is* the response, so a golden
that redacts it asserts almost nothing.

## Consequences

- **Two readiness harnesses, not one.** The Electron suite cannot see
  `updateHighlights`, so it must wait on a test-supplied predicate over
  `onDidChangeDiagnostics`, with a timeout. That harness cannot express
  "this document has no errors" — `[]` is stable from the first instant — and
  the limitation is documented rather than worked around.
- **The suite is version-pinned where it freezes content.** Regressions specific
  to another Rocq version are out of its reach by design; that compatibility
  axis has its own mechanism in this repository (`ppx_optcomp`'s 57
  `[%%if rocq = ...]` blocks).
- **Goldens will break when Rocq 9.2 output changes**, which is their purpose.
  The failure mode to guard against is procedural, not technical: regenerating
  without reading the diff turns the suite into a certificate for whatever the
  server does today. The suite README states what to look for before accepting a
  regeneration.
- **Two readiness predicates, and the second one outlived its reason.**
  `waitUntilRechecked` existed because `waitUntilChecked` was a false positive
  after an edit. With V11 fixed it is no longer load-bearing for that, and it
  was kept anyway: its first stage fails loudly on an edit that causes no work,
  and it is what would catch the truncation regressing. Post-edit waiting stays
  a distinct call rather than collapsing back into one, so that the distinction
  survives in the API and not only in this document.
- **A defect found while writing a golden is fixed first when the fix is small**
  (the inverted range in `jump_to_definition` is one line), and characterized
  as-is, marked, when it is not. Freezing a known defect silently is excluded in
  both cases.
