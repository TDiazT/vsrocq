import * as assert from "node:assert";

import {
    DiagnosticSeverity,
    HoverRequest,
    Position,
    Range,
} from "vscode-languageserver-protocol/node";

import { LspHarness, endOfDocument } from "./harness";

/** The empty range at `position`, i.e. an insertion point. */
function insertionAt(position: Position): Range {
    return { start: position, end: position };
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
 * A tactic that recurses forever has to be one sentence's error, not the end
 * of the server.
 *
 * Unlike `deepTerm.test.ts`, no stack size fixes this one: the recursion is
 * unbounded, so it reaches whatever guard page it is given. What has to work
 * instead is the reporting, and that needs two things, both in
 * `dm/proverThreadStubs.c`:
 *
 *  - An alternate signal stack, because the handler cannot run on the stack
 *    that just ran out. That one arrives with the thread itself — see the
 *    commit that asks pthread for 8 MB — since the runtime installs one only
 *    for threads it creates, not for one registered through
 *    `caml_c_thread_register`.
 *  - A handler for `SIGBUS`. OCaml installs its stack-overflow handler for
 *    `SIGSEGV` only, and macOS reports a *secondary* thread hitting its guard
 *    page as `SIGBUS`, because a pthread's guard is an `mprotect`'d mapping
 *    rather than an unmapped region. That is what this test's commit adds.
 *
 * With either piece missing the server dies outright, and every open document
 * dies with it; the suite sees `Connection is closed`. This test therefore
 * asserts three separate things, because "the process is still alive" is the
 * weakest of them and the easiest to pass by accident: the offending sentence
 * gets the error, the sentences after it still check, and the document can
 * still be edited afterwards.
 *
 * On Linux the platform already delivered `SIGSEGV` and the runtime already
 * caught it, so this only bites on the macOS cells of the matrix.
 */
describe("non-terminating tactics", () => {
    it("reports a stack overflow as a sentence error and keeps the document usable", async function () {
        // Chains a check, a re-check and two requests, each with its own
        // budget; see the note in didChange.test.ts.
        this.timeout(60000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument("stackOverflow.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));

            // --- 1. the offending sentence gets the error -------------------
            const diagnostics = harness.latestDiagnostics(uri) ?? [];
            const overflowLine = positionOf(text, "(let rec loop").line;
            const overflow = diagnostics.find((d) =>
                /stack overflow/i.test(d.message),
            );
            assert.ok(
                overflow,
                "no diagnostic mentions a stack overflow; the sentence that " +
                    `ran out of stack was reported as ${JSON.stringify(
                        diagnostics.map((d) => d.message),
                    )}`,
            );
            assert.strictEqual(
                overflow.range.start.line,
                overflowLine,
                "the overflow is reported against a line other than the one " +
                    "holding the tactic",
            );
            assert.strictEqual(overflow.severity, DiagnosticSeverity.Error);

            // --- 2. the rest of the document keeps checking -----------------
            //
            // `Qed.` fails as a consequence of the tactic never closing the
            // goal, and that is the only other diagnostic there should be: the
            // two definitions below it are unrelated to the proof and have to
            // check, which is what makes this "checking continued" rather than
            // "checking stopped and nothing else was reported".
            const afterQed = diagnostics.filter(
                (d) => d.range.start.line > positionOf(text, "Qed.").line,
            );
            assert.deepStrictEqual(
                afterQed,
                [],
                "the sentences after the failed proof were expected to check " +
                    "cleanly, so a diagnostic on any of them means checking " +
                    "did not carry on past the overflow",
            );

            // Stronger than the absence of a diagnostic, which a sentence that
            // was never checked at all also satisfies: hover only answers for
            // a name whose defining sentence went through.
            const hover = await harness.connection.sendRequest(
                HoverRequest.type,
                {
                    textDocument: { uri },
                    position: positionOf(text, "after_the_overflow."),
                },
            );
            assert.ok(
                hover,
                "hover answered nothing for a name defined after the " +
                    "overflowing sentence, so that sentence was never checked",
            );

            // --- 3. the document can still be edited ------------------------
            //
            // The edit appends a sentence rather than repairing the offending
            // one, because repairing it in place is not re-checked at all —
            // measured against this same fixture with the tactic replaced by a
            // benign one, so it is a property of how vsrocq invalidates an
            // edit inside a proof, not a consequence of the overflow. Asserting
            // on it here would test that instead of this.
            const appended = await harness.applyEdit(
                uri,
                insertionAt(endOfDocument(text)),
                "\nDefinition appended : nat := uses_it.",
            );
            await harness.waitUntilRechecked(uri, appended.end);

            // A request rather than a wait, for the reason spelled out in
            // didChange.test.ts: the server publishes `[]` when it invalidates
            // the edited sentences, before re-checking them, so diagnostics
            // alone are equally the state of a re-check that never happened.
            // `uses_it.` with the period occurs only in the appended line, so
            // this is hover over a *use*, which is where hover answers — and it
            // answers only if the name resolves, i.e. if the new sentence was
            // executed on top of the state the overflow left behind. The
            // response doubles as the barrier that makes the assertion below
            // need no waiting of its own.
            const hoverAfterEdit = await harness.connection.sendRequest(
                HoverRequest.type,
                {
                    textDocument: { uri },
                    position: positionOf(appended.text, "uses_it."),
                },
            );
            assert.ok(
                hoverAfterEdit,
                "hover answered nothing for a name the appended sentence " +
                    "refers to, so the server never checked anything after " +
                    "the overflow",
            );
            assert.deepStrictEqual(
                harness
                    .latestDiagnostics(uri)
                    ?.filter(
                        (d) => d.range.start.line >= appended.end.line - 1,
                    ),
                [],
                "the appended sentence is well typed, so a diagnostic on it " +
                    "means the state the overflow left behind is unusable",
            );
        } finally {
            await harness.shutdown();
        }
    });
});
