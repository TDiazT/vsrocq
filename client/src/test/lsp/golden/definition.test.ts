import * as path from "node:path";

import {
    DefinitionRequest,
    Location,
} from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";

import { expectGolden } from "../golden";
import {
    LspHarness,
    compileFixture,
    endOfDocument,
    fixturesDir,
} from "../harness";

/**
 * Rewrites the absolute file URI the server answers with into the fixture
 * path it stands for, so that the golden does not freeze in place the
 * directory this checkout happens to live in.
 *
 * Only the URI is rewritten. The `Range` is what this test is really about,
 * and it is compared exactly. Anything that is not an array of locations is
 * passed through as it came, so that a regression to `null` shows up as a
 * golden mismatch that reads as `null` rather than as a crash in here.
 */
function relativeToFixtures(response: unknown): unknown {
    if (!Array.isArray(response)) {
        return response;
    }
    return (response as Location[]).map((location) => ({
        ...location,
        uri: path.relative(fixturesDir, URI.parse(location.uri).fsPath),
    }));
}

describe("definition", () => {
    before(async function () {
        this.timeout(60000);
        await compileFixture("definition", "DefinitionFixture", "Target.v");
    });

    it("jumps to a name defined in a required library", async function () {
        this.timeout(20000);

        const harness = await LspHarness.start();
        try {
            const { uri, text } =
                await harness.openDocument("definition/Jump.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));

            // Line 2, character 33 lands inside the first "answer" of
            // "Definition twice_the_answer := answer + answer.". The name
            // comes from Target.v, which the `before` hook compiled and
            // Jump.v requires: a name defined in the open buffer is
            // `ToplevelInput` and gets no location at all.
            const definition = await harness.connection.sendRequest(
                DefinitionRequest.type,
                {
                    textDocument: { uri },
                    position: { line: 2, character: 33 },
                },
            );

            expectGolden("definition", relativeToFixtures(definition));
        } finally {
            await harness.shutdown();
        }
    });
});
