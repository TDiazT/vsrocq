import {
    Diagnostic,
    PublishDiagnosticsNotification,
} from "vscode-languageserver-protocol/node";

import { expectGolden } from "../golden";
import { LspHarness, endOfDocument } from "../harness";

describe("publishDiagnostics", () => {
    it("reports a type error against the offending definition", async function () {
        this.timeout(20000);

        const harness = await LspHarness.start();
        try {
            let latestDiagnostics: Diagnostic[] = [];
            let wake: (() => void) | undefined;
            harness.connection.onNotification(
                PublishDiagnosticsNotification.type,
                (params) => {
                    latestDiagnostics = params.diagnostics;
                    wake?.();
                },
            );

            const { uri, text } = await harness.openDocument(
                "publishDiagnostics.v",
            );
            await harness.waitUntilChecked(uri, endOfDocument(text));

            await new Promise<void>((resolve, reject) => {
                if (latestDiagnostics.length > 0) {
                    resolve();
                    return;
                }
                const timer = setTimeout(
                    () => reject(new Error("Timed out waiting for a non-empty diagnostics list")),
                    5000,
                );
                wake = () => {
                    if (latestDiagnostics.length === 0) {
                        return;
                    }
                    clearTimeout(timer);
                    resolve();
                };
            });

            expectGolden("publishDiagnostics", latestDiagnostics);
        } finally {
            await harness.shutdown();
        }
    });
});
