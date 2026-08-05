/**
 * The shape of `initializationOptions` / `workspace/didChangeConfiguration`'s
 * `settings`, matching `Settings.t` in `protocol/settings.ml` field for
 * field. The server parses this with `[@@yojson.allow_extra_fields]` at
 * every level, so unknown keys are tolerated, but every field listed here as
 * required is required. There is no schema negotiation, only what
 * `Settings.t_of_yojson` accepts.
 */
export interface Settings {
    proof: {
        delegation: "None" | "Skip" | "Delegate";
        workers?: number;
        mode: 0 | 1; // 0 = Manual, 1 = Continuous
        block: boolean;
        pointInterpretationMode: 0 | 1; // 0 = Cursor, 1 = NextCommand
    };
    goals: {
        diff: { mode: "on" | "off" | "removed" };
        messages: { full: boolean };
        ppmode?: "String" | "Pp";
    };
    completion: {
        enable: boolean;
        algorithm: 0 | 1;
        unificationLimit: number;
    };
    diagnostics: {
        enable?: boolean;
        full: boolean;
    };
    memory: { limit: number };
    interrupt: { preempt: boolean };
}

/**
 * Settings for a freshly spawned test server. Mirrors the defaults declared
 * in `client/package.json`'s `contributes.configuration`, with two
 * deliberate deviations required by the readiness predicate this harness
 * waits on (`LspHarness.waitUntilChecked`):
 *
 * - `proof.mode` is `Continuous` (1), not the extension's own default of
 *   `Manual` (0). In Manual mode nothing is ever checked until the client
 *   asks, so `processedRange` never reaches the end of the document.
 * - `proof.block` is `false`, not the extension's own default of `true`.
 *   With `block: true`, checking legitimately stops at the first error and
 *   `processedRange` never reaches the end of the document either.
 *
 * A test that needs Manual mode instead should start from this and override
 * `proof.mode`, then push the change with `sendConfiguration`. Do not rely
 * on the extension's own defaults, which this harness does not go through.
 */
export function defaultSettings(): Settings {
    return {
        proof: {
            delegation: "None",
            workers: 1,
            mode: 1,
            block: false,
            pointInterpretationMode: 0,
        },
        goals: {
            diff: { mode: "off" },
            messages: { full: true },
            ppmode: "Pp",
        },
        completion: {
            enable: false,
            algorithm: 1,
            unificationLimit: 100,
        },
        diagnostics: {
            full: false,
        },
        memory: { limit: 4 },
        interrupt: { preempt: false },
    };
}
