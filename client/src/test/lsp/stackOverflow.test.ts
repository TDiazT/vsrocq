import * as assert from "node:assert";

import {
    DiagnosticSeverity,
    HoverRequest,
    Position,
    Range,
} from "vscode-languageserver-protocol/node";

import { LspHarness, ServerExit, endOfDocument } from "./harness";

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
 * There are two tests below rather than one, and the split is the point.
 *
 * What vsrocq can guarantee is that the server never sits there: the first
 * test asserts that and nothing else, so it holds on every platform and every
 * run. What it cannot guarantee is that the overflow becomes a diagnostic. The
 * OCaml 4.14 runtime declines every overflow whose PC is in its own C rather
 * than in OCaml code — there is no OCaml frame to resume into — and how often
 * that happens is not a property of this fixture. One macOS box gave 70 in 100
 * one week and 2 to 8 in 100 the next; see the tables in
 * `audit/repro/stackoverflow/`. The second test asserts the behaviour we
 * actually want and steps aside on exactly that death, identified by its
 * signal *and* by the message the handler prints on its way out, so that any
 * other crash still fails. It will start passing outright under OCaml 5,
 * where OCaml code no longer runs on the pthread stack.
 *
 * Asserting the good outcome unconditionally would have left the macOS cells
 * red on most pushes, which is a slower way of not being read at all.
 *
 * With either piece missing the server dies outright, and every open document
 * dies with it; the suite sees `Connection is closed`. The second test
 * therefore asserts three separate things, because "the process is still
 * alive" is the weakest of them and the easiest to pass by accident: the
 * offending sentence gets the error, the sentences after it still check, and
 * the document can still be edited afterwards.
 *
 * Linux is not exempt, only quieter. The runtime declines a fault in its own C
 * there too, and the process dies of the retry — measured, with the same
 * probe, in `audit/repro/stackoverflow/`. What Linux never had is the *loop*:
 * the rejection path disarms `SIGSEGV` by name, which off macOS is the signal
 * actually being delivered.
 *
 * So the step-aside covers Linux as well, and the thing that had been missing
 * before it could is a way to tell that death apart from any other `SIGSEGV`.
 * There was none: nothing of ours ran, the runtime declined in silence and the
 * retry killed the process, leaving `died with SIGSEGV` as the whole of what a
 * caller could say. `dm/proverThreadStubs.c` now wraps the runtime's own
 * handler on Linux and prints the same sentence macOS prints, gated on the
 * fault having landed on the prover thread's guard page — so a plain
 * segmentation fault, which the runtime declines through that very same
 * branch, stays silent and stays a failure. The `segv` case in
 * `audit/repro/stackoverflow/` is that gate's negative control, and exists
 * because without it the two are indistinguishable from here.
 *
 * The Linux *rate* — how often the real server lands in the runtime's C rather
 * than in OCaml code — was the reason given for leaving these cells strict, and
 * it turns out not to be a number. Driving this fixture on one Arch x86_64 box
 * with Rocq 9.2: none in 60 runs idle, none in 100 at load average 32, then 72
 * in 100 at load average 50, then none in 40 at that same load an hour later.
 * CI says the same thing from the other side — four `install-opam` cells hit it
 * in one run, two of which had been green in the run before. macOS is no
 * steadier: four batches of 100 minutes apart span 2% to 8% there, against the
 * 70% seen on that same machine earlier in the month. So the step-aside is
 * keyed to a death that identifies itself rather than to a frequency, which is
 * the only thing here that holds still.
 */
/**
 * What `vsrocq_stack_fault_handler` prints before ending the process. Matching
 * on it rather than on the signal alone is what keeps an unrelated crash from
 * being waved through; see `knownDecline`.
 */
const DECLINE_MARKER = "ran out of stack inside the OCaml runtime";

/**
 * The signal the prover thread dies of when the runtime declines its overflow,
 * per platform — and the two are not the same signal, which is the reason this
 * is a table rather than a constant.
 *
 * macOS delivers a secondary thread's guard-page hit as `SIGBUS`, because a
 * pthread's guard is an `mprotect`'d mapping; Linux maps no guard at all, so
 * it is an ordinary `SIGSEGV` there. Reading the wrong one for the platform
 * would be worse than reading none: on Linux `SIGBUS` is a genuine bus error
 * and on macOS `SIGSEGV` is a fault the runtime already handles, so each
 * platform's *other* signal is a defect that must keep failing.
 *
 * A platform absent from this table has no recognised death and so no
 * step-aside — Windows, where none of the handler is compiled at all.
 */
const DECLINE_SIGNAL: Partial<Record<NodeJS.Platform, NodeJS.Signals>> = {
    darwin: "SIGBUS",
    linux: "SIGSEGV",
};

/**
 * The one death this file tolerates: the OCaml runtime declining an overflow
 * that reached the guard page from inside its own C, which the handler in
 * `dm/proverThreadStubs.c` turns into an immediate and explained exit.
 *
 * Both halves are required. The signal alone would also match a genuine fault
 * at an unrelated address, which is a different bug and should fail; the
 * message alone would match a server that printed it and then died of
 * something else. Returns the sentence to report, so that a skipped run says
 * which shortfall it hit rather than merely that it was skipped.
 */
export function knownDecline(
    platform: NodeJS.Platform,
    exit: ServerExit | undefined,
    stderr: string,
): string | undefined {
    const signal = DECLINE_SIGNAL[platform];
    if (signal === undefined) {
        return undefined;
    }
    if (exit === undefined || exit.signal !== signal) {
        return undefined;
    }
    if (!stderr.includes(DECLINE_MARKER)) {
        return undefined;
    }
    return (
        "the OCaml 4.14 runtime declined the fault and the server exited on " +
        `purpose after ${(exit.afterMs / 1000).toFixed(1)}s; see the ` +
        "rejection branch in dm/proverThreadStubs.c"
    );
}

describe("knownDecline", () => {
    // The step-aside below is the one thing in this file that can hide a
    // failure, and whether it is exercised at all on a given run is a matter
    // of where the guard page happened to be reached — and, now, of which
    // platform the run is on. So it is pinned down here instead, where every
    // case runs every time, on every platform.
    const declined = (signal: NodeJS.Signals): ServerExit => ({
        code: null,
        signal,
        afterMs: 340,
    });
    const stderr =
        "vsrocqtop: fatal: the prover thread ran out of stack inside the " +
        "OCaml runtime rather than in OCaml code.\n";

    // The signal is per platform because the platforms deliver different ones
    // for the same event; see `DECLINE_SIGNAL`.
    const recognised: Array<[NodeJS.Platform, NodeJS.Signals]> = [
        ["darwin", "SIGBUS"],
        ["linux", "SIGSEGV"],
    ];

    for (const [platform, signal] of recognised) {
        it(`recognises the runtime declining a fault on ${platform}, and says so`, () => {
            const reason = knownDecline(
                platform,
                declined(signal),
                stderr,
            );
            assert.match(reason ?? "", /declined the fault/);
            assert.match(reason ?? "", /0\.3s/);
        });

        it(`does not wave through a crash that printed nothing on ${platform}`, () => {
            // A fault at an unrelated address reaches the same signal by a
            // different route, and is a defect rather than the documented
            // shortfall. The handler stays silent for it precisely so that
            // this stays a failure — see the `segv` and `bus` cases in
            // `audit/repro/stackoverflow/`.
            assert.strictEqual(
                knownDecline(platform, declined(signal), ""),
                undefined,
            );
        });

        it(`does not wave through a different death on ${platform}`, () => {
            const others = (
                ["SIGBUS", "SIGSEGV", "SIGABRT", "SIGKILL"] as const
            ).filter((s) => s !== signal);
            for (const other of others) {
                assert.strictEqual(
                    knownDecline(platform, declined(other), stderr),
                    undefined,
                    `${other} is not the death ${platform} tolerates`,
                );
            }
            assert.strictEqual(
                knownDecline(
                    platform,
                    { code: 1, signal: null, afterMs: 10 },
                    stderr,
                ),
                undefined,
                "an exit code is not a signal death",
            );
        });

        it(`does not wave through a server that is still running on ${platform}`, () => {
            assert.strictEqual(
                knownDecline(platform, undefined, stderr),
                undefined,
            );
        });
    }

    it("does not read one platform's signal on the other", () => {
        // Each platform's *other* signal is a real defect there: SIGBUS on
        // Linux is a genuine bus error, and SIGSEGV on macOS is a fault the
        // runtime already handles. Crossing the two would wave both through.
        assert.strictEqual(
            knownDecline("darwin", declined("SIGSEGV"), stderr),
            undefined,
        );
        assert.strictEqual(
            knownDecline("linux", declined("SIGBUS"), stderr),
            undefined,
        );
    });

    it("recognises nothing on a platform the handler is not built for", () => {
        // None of `dm/proverThreadStubs.c`'s signal handling is compiled on
        // Windows, so there is no death there for this to name.
        for (const signal of ["SIGBUS", "SIGSEGV"] as const) {
            assert.strictEqual(
                knownDecline("win32", declined(signal), stderr),
                undefined,
            );
        }
    });
});

/**
 * How long to let the overflow take.
 *
 * Both tests below wait for the same fixture to finish checking, so both have
 * to allow the same time, and this is shared rather than written twice because
 * once it was not: the weaker test asked for 30s and the stronger one took the
 * harness default of 10s, and on a slow runner the difference alone failed it.
 * `nix-dev-build (macos-latest, 9-2)` is where that showed: the overflow took
 * 12.4s there — the whole file took 29s against 5–7s elsewhere — so the weaker
 * test passed and the stronger one timed out with the server still working,
 * reported as a wedge it was not.
 *
 * Long enough for the slowest runner seen, and no longer. It does not weaken
 * what the tests catch: the wedge this file exists for is a server spinning in
 * its own signal handler with nothing left to say, which no budget rescues —
 * it is caught by the process still being alive when the wait gives up, and
 * that check is unchanged. All a larger budget buys is the right reason for
 * the report.
 */
const OVERFLOW_BUDGET_MS = 30000;

describe("non-terminating tactics", () => {
    // The invariant vsrocq is actually able to hold, asserted on its own so
    // that it is checked on every platform and every run: however the overflow
    // lands, the server reaches an end. Before the handler was fixed this was
    // the failing half — the process spun in its own signal handler at 100%
    // CPU, answering nothing and never exiting, and the suite hung with it.
    it("never leaves the server wedged, whichever way the overflow lands", async function () {
        this.timeout(60000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument("stackOverflow.v");
            try {
                await harness.waitUntilChecked(
                    uri,
                    endOfDocument(text),
                    OVERFLOW_BUDGET_MS,
                );
            } catch (error) {
                // Dying is an acceptable end here; this test is about the
                // third outcome. `waitUntilChecked` rejects the moment the
                // process ends, so an exit record by now distinguishes "it
                // died" from "it ran out of time still running".
                assert.ok(
                    harness.serverExit(),
                    "the server neither reported the overflow nor died — it " +
                        "was still running with nothing left to say, which " +
                        `is the wedge this must never do: ${error}`,
                );
            }
        } finally {
            await harness.shutdown();
        }
    });

    it("reports a stack overflow as a sentence error and keeps the document usable", async function () {
        // Chains a check, a re-check and two requests, each with its own
        // budget; see the note in didChange.test.ts.
        this.timeout(60000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument("stackOverflow.v");
            try {
                await harness.waitUntilChecked(
                    uri,
                    endOfDocument(text),
                    OVERFLOW_BUDGET_MS,
                );
            } catch (error) {
                const declined = knownDecline(
                    process.platform,
                    harness.serverExit(),
                    harness.serverStderr(),
                );
                if (declined === undefined) {
                    throw error;
                }
                // Pending rather than failing: everything below describes what
                // vsrocq wants and what OCaml 4.14 cannot always give, and
                // this run is that documented shortfall rather than a new
                // defect. The reason is printed because mocha shows a pending
                // test as a bare title, and "skipped" without "why" is how a
                // shortfall turns into folklore.
                process.stderr.write(`\n    skipped: ${declined}\n`);
                this.skip();
            }

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
