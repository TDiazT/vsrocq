import { CompletionRequest } from "vscode-languageserver-protocol/node";

import { defaultSettings } from "../settings";
import { expectGolden } from "../golden";
import { LspHarness, endOfDocument } from "../harness";

describe("completion", () => {
    it("suggests terms whose type matches the open goal", async function () {
        this.timeout(20000);

        // completion.enable defaults to false (client/package.json), so a
        // harness started with defaultSettings() always gets back
        // isIncomplete: false, items: [] regardless of position.
        const settings = defaultSettings();
        settings.completion.enable = true;

        const harness = await LspHarness.start(settings);
        try {
            const { uri, text } = await harness.openDocument("completion.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));

            // Line 6 is the blank line between "Proof." and "Qed." for a
            // lemma of the fixture's own "widget" type, the term-mode hole
            // this feature suggests completions for. "widget" is a type
            // invented for this fixture, not a standard library one, so the
            // suggestions are limited to the handful of terms in the
            // fixture itself instead of everything of a common type (such
            // as "nat") available in the whole prelude.
            const completions = await harness.connection.sendRequest(
                CompletionRequest.type,
                {
                    textDocument: { uri },
                    position: { line: 6, character: 0 },
                },
            );

            if (completions === null || Array.isArray(completions)) {
                throw new Error(
                    `Expected a CompletionList, got ${JSON.stringify(completions)}`,
                );
            }

            // The server scores and returns every constant in the global
            // environment, not just the ones matching "widget" (about 1050
            // items for this fixture, since the whole prelude is loaded).
            // The ones whose type actually matches the goal are ranked
            // first, so comparing only the first few items still exercises
            // that ranking without pinning the entire prelude into a golden
            // file.
            expectGolden("completion", {
                isIncomplete: completions.isIncomplete,
                items: completions.items.slice(0, 5),
            });
        } finally {
            await harness.shutdown();
        }
    });
});
