import { HoverRequest } from "vscode-languageserver-protocol/node";

import { expectGolden } from "../golden";
import { LspHarness, endOfDocument } from "../harness";

describe("hover", () => {
    it("shows the type of a defined name at one of its use sites", async function () {
        this.timeout(20000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } = await harness.openDocument("hover.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));

            // Line 2, character 19 lands inside the first "one" of
            // "Definition two := one + one.".
            const hover = await harness.connection.sendRequest(
                HoverRequest.type,
                {
                    textDocument: { uri },
                    position: { line: 2, character: 19 },
                },
            );

            expectGolden("hover", hover);
        } finally {
            await harness.shutdown();
        }
    });
});
