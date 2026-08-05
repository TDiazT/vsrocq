import { LspHarness, endOfDocument } from "./harness";

/**
 * End-to-end proof that the harness itself works: spawn, initialize, open a
 * document, wait for it to be fully checked, shut down cleanly. No
 * assertions about what checking produced. That is what the per-feature
 * golden tests (`client/src/test/lsp/golden/`) are for.
 */
describe("LSP harness", () => {
    it("spawns vsrocqtop, checks a fixture, and shuts down", async function () {
        this.timeout(20000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument("smoke.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));
        } finally {
            await harness.shutdown();
        }
    });
});
