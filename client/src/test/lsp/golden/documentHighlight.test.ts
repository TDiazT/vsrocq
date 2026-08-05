import { DocumentHighlightRequest } from "vscode-languageserver-protocol/node";

import { expectGolden } from "../golden";
import { LspHarness, endOfDocument } from "../harness";

describe("documentHighlight", () => {
    it("finds every occurrence of the identifier under the cursor", async function () {
        this.timeout(20000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument("hover.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));

            // Line 2, character 19 lands inside the first "one" of
            // "Definition two := one + one.". "one" also occurs on line 0
            // (its own definition) and a second time on line 2.
            const highlights = await harness.connection.sendRequest(
                DocumentHighlightRequest.type,
                {
                    textDocument: { uri },
                    position: { line: 2, character: 19 },
                },
            );

            expectGolden("documentHighlight", highlights);
        } finally {
            await harness.shutdown();
        }
    });
});
