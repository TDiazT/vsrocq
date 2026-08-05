import { DocumentSymbolRequest } from "vscode-languageserver-protocol/node";

import { expectGolden } from "../golden";
import { LspHarness, endOfDocument } from "../harness";

describe("documentSymbol", () => {
    it("returns the outline for a section holding a definition, an inductive, and a lemma", async function () {
        this.timeout(20000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument(
                "documentSymbol.v",
            );
            await harness.waitUntilChecked(uri, endOfDocument(text));

            const symbols = await harness.connection.sendRequest(
                DocumentSymbolRequest.type,
                { textDocument: { uri } },
            );

            expectGolden("documentSymbol", symbols);
        } finally {
            await harness.shutdown();
        }
    });
});
