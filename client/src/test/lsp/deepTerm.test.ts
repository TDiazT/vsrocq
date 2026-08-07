import * as assert from "assert";
import { LspHarness, endOfDocument } from "./harness";

/**
 * The prover thread has to be able to elaborate a deeply nested term.
 *
 * How deep it can go is bounded by the stack the thread runs on, and
 * `Thread.create` leaves that size to the platform: Linux hands a secondary
 * thread the same 8 MB the main thread gets, but macOS hands it 512 KB. On
 * macOS that ran out at roughly 950 levels of nesting — a `nat` literal of
 * 1000 was already past it — and the overflow was not a diagnostic but the
 * death of the whole server: OCaml installs its stack-overflow handler for
 * SIGSEGV, and macOS reports a secondary thread hitting its guard page as
 * SIGBUS, so `vsrocqtop` died with no message, no log entry, and every open
 * document lost. `dm/proverThread.ml` now asks for the same 8 MB the main
 * thread gets, which puts the ceiling where `rocq compile` has it.
 *
 * The literal here is 2000, comfortably past the old macOS limit and far
 * short of the 5001 at which `nat`'s number notation stops expanding. On
 * Linux the platform default already covered this, so this test only really
 * bites on the macOS and Windows cells of the matrix.
 */
describe("deeply nested terms", () => {
    it("checks a term whose nesting exceeds the default secondary-thread stack", async function () {
        this.timeout(20000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument("deepTerm.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));

            assert.deepStrictEqual(
                harness.latestDiagnostics(uri) ?? [],
                [],
                "the sentence should check cleanly, not report an error",
            );
        } finally {
            await harness.shutdown();
        }
    });
});
