import * as assert from "node:assert/strict";

import { resolveVsrocqtop } from "../harness";

/**
 * That the goldens are compared against a server started the same way
 * wherever they run.
 *
 * This is the regression test for the failure that prompted
 * `useFixedServerArguments`: with `VSROCQARGS: -bt` exported by the
 * `install-opam` job, every diagnostic message reached the client with a
 * ~20-frame Rocq backtrace appended, and `publishDiagnostics.json` — captured
 * without one — could not match. The whole of the fix is `fixedArguments.ts`
 * being loaded before this suite runs, so the thing worth guarding is that it
 * still is: drop the `--require` from `test:lsp:golden` and this test fails,
 * in the same mocha process the goldens themselves run in.
 *
 * Asserting on `resolveVsrocqtop` rather than on a spawned server keeps it
 * free of Rocq: it is the one test in this directory that says nothing about
 * any Rocq version, and it costs no process.
 */
describe("a golden test's server", () => {
    it("is spawned with fixed arguments, not with the environment's", () => {
        // Restored by deletion when it was unset, not by assigning back what
        // was read: `process.env.X = undefined` stores the *string*
        // `"undefined"`, which every later spawn in this mocha process would
        // then pass to the server as an argument.
        const previous = process.env.VSROCQARGS;
        process.env.VSROCQARGS = "-bt";
        try {
            assert.ok(
                !resolveVsrocqtop().args.includes("-bt"),
                "the golden suite inherited VSROCQARGS; is fixedArguments.ts " +
                    "still on the --require of test:lsp:golden?",
            );
        } finally {
            if (previous === undefined) {
                delete process.env.VSROCQARGS;
            } else {
                process.env.VSROCQARGS = previous;
            }
        }
    });
});
