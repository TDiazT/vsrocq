import { expectGolden } from "../golden";
import { LspHarness, endOfDocument } from "../harness";

describe("publishDiagnostics", () => {
    it("reports a type error against the offending definition", async function () {
        this.timeout(20000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument(
                "publishDiagnostics.v",
            );
            await harness.waitUntilChecked(uri, endOfDocument(text));

            // Not read off `latestDiagnostics` directly: the notification
            // carrying the error arrives just after the `updateHighlights`
            // that reports checking as finished, since `update_view` sends
            // the two in that order (`lspManager.ml`).
            const diagnostics = await harness.waitForDiagnostics(
                uri,
                (d) => d.length > 0,
                5000,
            );

            expectGolden("publishDiagnostics", diagnostics);
        } finally {
            await harness.shutdown();
        }
    });
});
