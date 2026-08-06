import * as assert from "node:assert";

import {
    DiagnosticSeverity,
    HoverRequest,
    Position,
    Range,
} from "vscode-languageserver-protocol/node";

import { LspHarness, UpdateHighlightsParams, endOfDocument } from "./harness";

/** The empty range at `position`, i.e. an insertion point. */
function insertionAt(position: Position): Range {
    return { start: position, end: position };
}

/** The range covering `line` in `text`, newline excluded. */
function wholeLine(text: string, line: number): Range {
    return {
        start: { line, character: 0 },
        end: { line, character: text.split("\n")[line].length },
    };
}

/** The position of the first character of `needle` in `text`. */
function positionOf(text: string, needle: string): Position {
    const offset = text.indexOf(needle);
    assert.notStrictEqual(
        offset,
        -1,
        `the test's own expectation is broken: ${JSON.stringify(needle)} is ` +
            `not in the document`,
    );
    const before = text.slice(0, offset).split("\n");
    return {
        line: before.length - 1,
        character: before[before.length - 1].length,
    };
}

/**
 * The edit cycle: `didChange`, and the re-check that follows it.
 *
 * Every other test in this suite opens a document, asks one question and closes
 * it, so nothing covered the path an actual editing session spends all of its
 * time on. These tests are also the ones that will notice if a change to how
 * diagnostics are published — the `spike/diagnostics-*` branches both rewrite
 * exactly this path — stops the client from ever hearing the final state.
 *
 * All waiting after an edit goes through `waitUntilRechecked`, never
 * `waitUntilChecked`: the latter returns immediately after a `didChange` and
 * reports success while the server is still recomputing (finding V11). See its
 * docstring in `harness.ts` for why the two-stage version is not vulnerable to
 * that. The last test here is the one that characterizes V11 itself.
 */
describe("textDocument/didChange", () => {
    it("re-checks after an edit: an introduced error appears, and a second edit clears it", async function () {
        // Higher than the rest of the suite's 20s because this chains four
        // waits, each with its own 10s budget. The point is that on a slow CI
        // runner the failure is one of *those* timeouts, which names the last
        // notification received, rather than mocha's, which names nothing.
        this.timeout(60000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument("didChange.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));
            assert.deepStrictEqual(
                harness.latestDiagnostics(uri),
                [],
                "the fixture is supposed to check cleanly; the rest of this " +
                    "test reads diagnostics as consequences of its own edits",
            );

            // --- The edit that introduces an error --------------------------
            const broken = "Definition broken : nat := true.";
            const brokenLine = endOfDocument(text).line + 2;
            const introduced = await harness.applyEdit(
                uri,
                insertionAt(endOfDocument(text)),
                `\n\n${broken}`,
            );
            await harness.waitUntilRechecked(uri, introduced.end);

            const [diagnostic, ...extra] = await harness.waitForDiagnostics(
                uri,
                (diagnostics) => diagnostics.length > 0,
            );
            assert.deepStrictEqual(
                extra,
                [],
                "the fixture is built so that an error in the appended line " +
                    "cascades into nothing; more than one diagnostic means " +
                    "either the fixture or the server changed",
            );
            assert.strictEqual(
                diagnostic.range.start.line,
                brokenLine,
                "the diagnostic is expected against the line the edit added",
            );
            assert.strictEqual(diagnostic.severity, DiagnosticSeverity.Error);
            // Loose on purpose: the wording of Rocq's type error is not what
            // this test protects, and this file runs on every Rocq in the
            // matrix. The mention of `bool` is what makes this the error the
            // edit introduced rather than some other one.
            assert.match(diagnostic.message, /bool/);

            // --- The edit that repairs it -----------------------------------
            //
            // `uses_repaired` is there for the hover below: it puts the newly
            // defined name in a second position, which is where hover is known
            // to answer (see `golden/hover.test.ts`).
            const repaired =
                "Definition repaired : nat := 4.\n" +
                "Definition uses_repaired : nat := repaired.";
            const fixed = await harness.applyEdit(
                uri,
                wholeLine(harness.documentText(uri), brokenLine),
                repaired,
            );
            await harness.waitUntilRechecked(uri, fixed.end);

            // A request, not a wait, and deliberately one whose answer depends
            // on the new text. Waiting for the diagnostics to go empty would
            // prove much less: the server publishes `[]` when it *invalidates*
            // the edited sentences, before re-checking them (measured — the
            // empty list arrives ~20ms before checking ends), so `[]` on its
            // own is also the state of a re-check that has not happened.
            //
            // Measured while writing this: hover answers nothing when the
            // sentence defining the name failed to check, so this asserts
            // something stronger than "the new text was parsed" — the name
            // resolves, i.e. the new definition went through.
            //
            // It doubles as the barrier that makes the assertion below need no
            // waiting of its own: the response is written after everything the
            // server had already written, and the client processes the stream
            // in order, so by the time it arrives every diagnostics
            // notification sent during checking has been handled.
            const hover = await harness.connection.sendRequest(
                HoverRequest.type,
                {
                    textDocument: { uri },
                    position: positionOf(
                        harness.documentText(uri),
                        "repaired.",
                    ),
                },
            );
            assert.ok(
                hover,
                "hover answered nothing for a name the repairing edit " +
                    "introduced, which means the server never took the new " +
                    "text into account",
            );

            assert.deepStrictEqual(
                harness.latestDiagnostics(uri),
                [],
                "the error the first edit introduced is still being reported " +
                    "after the edit that repaired it was checked",
            );
        } finally {
            await harness.shutdown();
        }
    });

    it("publishes the final diagnostics even when the document goes quiet right after the edit", async function () {
        this.timeout(60000); // See the note on the previous test.

        // The failure mode this exists for: a `publish_diagnostics` that is
        // throttled, or skipped when "nothing changed", can drop the *last*
        // update of a burst. Nothing then triggers another one — the document
        // is quiet, the client sends nothing — so the client keeps showing an
        // intermediate state indefinitely. That is invisible to any test that
        // keeps talking to the server afterwards.
        //
        // The end state asserted here has two errors, not zero, and that is
        // the point. Asserting on an empty list would be satisfied by the `[]`
        // the server publishes when it invalidates the edited sentences,
        // before it re-checks anything, so a dropped final publish would go
        // unnoticed. Reaching two requires the second error to have been found
        // *and* published.
        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument("didChange.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));

            const appendBrokenDefinition = async (name: string) => {
                const end = endOfDocument(harness.documentText(uri));
                const edit = await harness.applyEdit(
                    uri,
                    insertionAt(end),
                    `\n\nDefinition ${name} : nat := true.`,
                );
                await harness.waitUntilRechecked(uri, edit.end);
                return end.line + 2;
            };

            const firstLine = await appendBrokenDefinition("first_broken");
            await harness.waitForDiagnostics(uri, (d) => d.length === 1);

            const secondLine = await appendBrokenDefinition("second_broken");

            // Nothing is sent to the server from here on. If the final publish
            // never comes, this is where it shows.
            const diagnostics = await harness.waitForDiagnostics(
                uri,
                (d) => d.length === 2,
            );
            assert.deepStrictEqual(
                diagnostics
                    .map((d) => d.range.start.line)
                    .sort((a, b) => a - b),
                [firstLine, secondLine],
                "both errors are expected, against the two lines the edits " +
                    "added; the order the server lists them in is not " +
                    "positional, hence the sort",
            );
        } finally {
            await harness.shutdown();
        }
    });

    // Finding V11, unfixed. Kept as a written test rather than a note: it is
    // the shape a fix has to satisfy, and that fix is a change to
    // `DocumentManager.apply_text_edits` that belongs in its own commit.
    //
    // The scenario is built so that the notification under test cannot be
    // mistaken for anything else. The edit inserts a whole line, so the end of
    // the document moves from line N to line N+1, and `shift_overview` shifts
    // the stale `processedRange` along with it. The offending notification
    // therefore reports a `processedRange` ending at the *new* end of the
    // document — a value that did not exist before the edit, so it cannot be
    // one of the duplicate terminal notifications the server repeats with
    // identical payloads (V6). Measured on this fixture:
    // `prep=[] proc=[] done=[0:0-26:28]` 1ms after the `didChange`, then
    // `prep=[0:0-26:28] proc=[] done=[0:0-24:24]` 3ms later — work still to do
    // on a document the server had just described as finished.
    //
    // To fix: `apply_text_edits` shifts the overview but does not truncate it
    // at the edit. Truncating there — dropping, in all three lists, everything
    // at or after the edit's start position — would make this notification
    // report the document as checked only up to the edit, which is true. The
    // truncated overview does get built later, by `reset_overview` when
    // parsing ends, which is why the state eventually becomes correct; the bug
    // is confined to the window before that, and that window is exactly where
    // a client decides whether to believe the document is ready.
    it.skip("does not report the document as fully checked while it is still re-checking", async function () {
        this.timeout(60000); // See the note on the first test.

        const harness = await LspHarness.start();
        try {
            const highlights: UpdateHighlightsParams[] = [];
            harness.onHighlights((params) => highlights.push(params));

            const { uri, text } = await harness.openDocument("didChange.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));

            const mark = highlights.length;
            const edited = await harness.applyEdit(
                uri,
                insertionAt(positionOf(text, "Definition one : nat := 1.")),
                "Definition inserted : nat := 0.\n",
            );

            // Established first, so that the assertion below cannot pass by
            // being evaluated too early: the server does have work left after
            // the edit, and says so. Everything it sent before this point was
            // sent while the re-check had not started.
            const working = await harness.waitUntil(
                () => {
                    const index = highlights.findIndex(
                        (params, at) =>
                            at >= mark &&
                            (params.preparedRange.length > 0 ||
                                params.processingRange.length > 0),
                    );
                    return index === -1 ? undefined : index;
                },
                () =>
                    "a prover/updateHighlights showing work in progress on " +
                    "the edited document",
                5000,
            );

            const premature = highlights
                .slice(mark, working)
                .filter((params) =>
                    harness.isCheckedTo(uri, edited.end, params),
                );
            assert.deepStrictEqual(
                premature,
                [],
                `the server reported the document as checked all the way to ` +
                    `its new end before starting to re-check it: ` +
                    `${JSON.stringify(premature)}, followed by ` +
                    `${JSON.stringify(highlights[working])}. A client keyed ` +
                    `on the readiness predicate reports "ready" here while ` +
                    `the re-check is still running (V11)`,
            );

            await harness.waitUntilRechecked(uri, edited.end);
        } finally {
            await harness.shutdown();
        }
    });
});
