import * as assert from "node:assert";

import {
    DocumentSymbolRequest,
    NotificationType,
    ResponseError,
    VersionedTextDocumentIdentifier,
} from "vscode-languageserver-protocol/node";

import { LspHarness, endOfDocument } from "./harness";
import { defaultSettings } from "./settings";

/**
 * `prover/interpretToEnd` is declared in `protocol/extProtocol.ml` under
 * `Notification.Client`, not in the standard LSP protocol package. Its
 * parameter is a `VersionedTextDocumentIdentifier`, so `version` is required:
 * omitting it makes the server drop the notification at decode time with
 * nothing but a log line.
 */
const InterpretToEndNotification = new NotificationType<{
    textDocument: VersionedTextDocumentIdentifier;
}>("prover/interpretToEnd");

/** LSP's `ServerCancelled`, which `documentSymbol` answers while parsing. */
const SERVER_CANCELLED = -32802;

/**
 * Regression test for a navigation request that arrived before the document
 * had been parsed.
 *
 * The server resolves `prover/interpretToEnd` by looking up the document's
 * last sentence, but sentences only reach the document once parsing has
 * finished, in one go. A request handled before that resolved to no sentence
 * and was dropped without a trace: no work scheduled, no error, no reply.
 *
 * This is Manual mode's problem alone. In Continuous mode the document gets
 * checked anyway, by a path that does not depend on the request surviving,
 * which is why the bug went unnoticed.
 */
describe("prover/interpretToEnd", () => {
    it("still runs when it arrives before parsing has finished", async function () {
        this.timeout(20000);

        const settings = defaultSettings();
        settings.proof.mode = 0; // Manual: nothing is checked unless asked.

        const harness = await LspHarness.start(settings);
        try {
            const { uri, text } = await harness.openDocument(
                "interpretToEnd.v",
            );

            // Sent without waiting for anything: the point of the test is
            // that this lands mid-parse. Nothing here races, despite the
            // wording — notifications are processed in arrival order, and
            // the LSP read event outranks parsing in `PriorityManager`, so
            // the server has this in hand before it parses a single
            // sentence.
            await harness.connection.sendNotification(
                InterpretToEndNotification,
                { textDocument: { uri, version: 1 } },
            );

            // Precondition, asserted rather than assumed. `documentSymbol`
            // answers `ServerCancelled` for exactly as long as
            // `DocumentManager.is_parsing` holds, so a successful reply here
            // would mean parsing had already finished by the time the server
            // reached the request above — leaving the test passing without
            // ever exercising the bug.
            const error = await harness.connection
                .sendRequest(DocumentSymbolRequest.type, {
                    textDocument: { uri },
                })
                .then(
                    () => undefined,
                    (reason: ResponseError<void>) => reason,
                );
            assert.strictEqual(
                error?.code,
                SERVER_CANCELLED,
                "expected the document to still be parsing when interpretToEnd " +
                    "was handled; without that this test cannot observe the bug",
            );

            await harness.waitUntilChecked(uri, endOfDocument(text));
        } finally {
            await harness.shutdown();
        }
    });
});
