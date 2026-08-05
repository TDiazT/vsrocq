import {
    NotificationType,
    Range,
} from "vscode-languageserver-protocol/node";

import { expectGolden } from "../golden";
import { LspHarness, endOfDocument } from "../harness";

/**
 * `prover/interpretToPoint` is declared in `protocol/extProtocol.ml` under
 * `Notification.Client`, not in the standard LSP protocol package. It moves
 * the server's navigation cursor (`observe_id`) to the sentence at or before
 * `position`, which for an already-checked sentence pushes back a
 * `prover/proofView`. `version` is unused by the server for this
 * notification (only `uri` is read), so any number is accepted.
 */
interface InterpretToPointParams {
    textDocument: { uri: string; version: number };
    position: { line: number; character: number };
}

const InterpretToPointNotification =
    new NotificationType<InterpretToPointParams>("prover/interpretToPoint");

/**
 * `prover/proofView` is declared in `protocol/extProtocol.ml` under
 * `Notification.Server`, mirroring `ProofViewParams.t`. There is no request
 * form: the only way to observe it is to trigger a push and listen for the
 * notification, as done here.
 */
interface ProofViewParams {
    range: Range;
    proof: unknown;
    messages: unknown;
    pp_proof: unknown;
    pp_messages: unknown;
}

const ProofViewNotification =
    new NotificationType<ProofViewParams>("prover/proofView");

describe("goals", () => {
    it("pushes the proof state at the sentence the cursor moves to", async function () {
        this.timeout(20000);

        const harness = await LspHarness.start();
        try {
            // Continuous mode's own background check pushes one
            // prover/proofView unconditionally for the document's last
            // sentence as soon as checking finishes (`observe` in
            // `checkingManager.ml` sets `observe_id` to that sentence before
            // background execution even starts), racing with this test's own
            // interpretToPoint call in a way that isn't safe to resolve by
            // counting notifications. What distinguishes the two is content,
            // not arrival order: the automatic push always lands on the
            // finished Qed with `proof: null`, while interpretToPoint here
            // targets a sentence with a still-open goal, so waiting for the
            // first non-null `proof` picks out the right one regardless of
            // how the two pushes interleave.
            const proofViews: ProofViewParams[] = [];
            let wake: (() => void) | undefined;
            harness.connection.onNotification(ProofViewNotification, (params) => {
                proofViews.push(params);
                wake?.();
            });

            const { uri, text } = await harness.openDocument("goals.v");
            await harness.waitUntilChecked(uri, endOfDocument(text));

            // Line 3, character 0 is the start of the "induction ..." line,
            // which is at or after the end of "intros n." (line 2) and
            // before the end of "induction ...". That resolves the cursor to
            // the "intros n." sentence, whose proof state is "n : nat |- n +
            // 0 = n".
            await harness.connection.sendNotification(
                InterpretToPointNotification,
                {
                    textDocument: { uri, version: 1 },
                    position: { line: 3, character: 0 },
                },
            );

            const targetProofView = await new Promise<ProofViewParams>(
                (resolve, reject) => {
                    const found = () => proofViews.find((pv) => pv.proof !== null);
                    const existing = found();
                    if (existing !== undefined) {
                        resolve(existing);
                        return;
                    }
                    const timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    "Timed out waiting for a prover/proofView with an open goal",
                                ),
                            ),
                        5000,
                    );
                    wake = () => {
                        const pv = found();
                        if (pv === undefined) {
                            return;
                        }
                        clearTimeout(timer);
                        resolve(pv);
                    };
                },
            );

            expectGolden("goals", targetProofView);
        } finally {
            await harness.shutdown();
        }
    });
});
