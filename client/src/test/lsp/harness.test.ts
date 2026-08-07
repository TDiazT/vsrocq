import * as assert from "node:assert";
import * as path from "node:path";

import { LspHarness } from "./harness";

/**
 * What the harness says when the server misbehaves.
 *
 * Every other test in this suite asserts on what `vsrocqtop` does; this one
 * asserts on what happens when it stops doing anything, which used to be
 * reported so badly that it took a separate investigation to learn *which*
 * test had been affected. Two failures that look alike from the outside and
 * need telling apart:
 *
 *  - The server died. The suite used to see `Connection is closed`, raised
 *    from the `shutdown()` call in a test's `finally` — the wrong place, and
 *    with no mention of the signal. Worse, it replaced whatever assertion had
 *    already failed.
 *  - The server is alive and no longer answering. `shutdown()` waited on a
 *    reply that would never come, so the run never ended; mocha printed
 *    nothing, npm printed nothing, and the suite looked stuck for no reason.
 *
 * The server here is `fakeServer.ts` rather than `vsrocqtop`, because the real
 * one only does these things by accident and only on macOS.
 */
describe("the harness, when the server misbehaves", () => {
    const fakeServer = path.resolve(__dirname, "fakeServer.js");

    /**
     * Runs `body` against a harness driving `fakeServer.js` in `mode`.
     *
     * The variables are restored by deleting them when they were unset, not by
     * assigning back what was read: `process.env.X = undefined` stores the
     * *string* `"undefined"`, and every later test file in the same mocha
     * process would then spawn it and fail with `spawn undefined ENOENT`.
     */
    async function withFakeServer(
        mode: "die" | "wedge",
        body: (harness: LspHarness) => Promise<void>,
    ): Promise<void> {
        const previous = {
            VSROCQPATH: process.env.VSROCQPATH,
            VSROCQARGS: process.env.VSROCQARGS,
        };
        // `resolveVsrocqtop` reads both at spawn time and splits the arguments
        // on spaces, so this is the whole of the substitution.
        process.env.VSROCQPATH = process.execPath;
        process.env.VSROCQARGS = `${fakeServer} --mode=${mode}`;
        try {
            await body(await LspHarness.start());
        } finally {
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = value;
                }
            }
        }
    }

    it("names the signal, and does so from the wait rather than from shutdown", async () => {
        await withFakeServer("die", async (harness) => {
            const startedAt = Date.now();
            const failure = await harness
                .waitUntil(
                    () => undefined,
                    () => "something that can no longer arrive",
                    10000,
                )
                .then(
                    () => undefined,
                    (error: Error) => error,
                );

            assert.ok(failure, "the wait resolved on a server that had died");
            assert.match(failure.message, /died with SIGBUS/);
            assert.match(
                failure.message,
                /something that can no longer arrive/,
                "the message drops what the test was waiting for",
            );
            // The point of failing on the `exit` event rather than on the
            // clock: 10s of a dead connection tells the reader nothing, and
            // multiplied across a suite it is most of a CI run.
            assert.ok(
                Date.now() - startedAt < 5000,
                "the wait sat out its full timeout instead of ending when " +
                    "the process did",
            );

            // And nothing further from the `finally` every test has: the
            // failure above is the one worth reporting, so this must not
            // throw over it.
            await harness.shutdown();
        });
    });

    it("kills a server that stops answering, and says so", async function () {
        // Four seconds of deliberate waiting: the deadline on the `shutdown`
        // request, then the same again for an exit that never comes.
        this.timeout(30000);

        await withFakeServer("wedge", async (harness) => {
            const startedAt = Date.now();
            const reported: string[] = [];

            // Reported rather than thrown, and the test asserts it that way
            // round on purpose: throwing from the `finally` every test has
            // would replace whatever failure sent it there. See `shutdown`.
            await harness.shutdown(2000, (message) => reported.push(message));

            assert.match(reported.join(""), /did not answer `shutdown`/);
            assert.match(reported.join(""), /SIGKILL/);
            // Ending the run at all is the part that matters: before this,
            // `shutdown()` waited here forever, mocha never finished, and npm
            // printed nothing at all because it buffers until the process
            // exits.
            assert.ok(
                Date.now() - startedAt < 15000,
                "shutdown() took long enough that it is still the thing " +
                    "holding up the run",
            );
            assert.strictEqual(
                await harness.isRunning(),
                false,
                "the server was left running, so mocha would wait on it",
            );
        });
    });
});
