import * as cp from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";

import {
    ConfigurationRequest,
    DidChangeConfigurationNotification,
    DidOpenTextDocumentNotification,
    ExitNotification,
    InitializeRequest,
    InitializedNotification,
    NotificationType,
    Position,
    ProtocolConnection,
    Range,
    ShutdownRequest,
    TextDocumentItem,
    createProtocolConnection,
} from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";

import { Settings, defaultSettings } from "./settings";

export const fixturesDir = path.resolve(
    __dirname,
    "../../../src/test/lsp/fixtures",
);

/**
 * `prover/updateHighlights` is declared in `protocol/extProtocol.ml` under
 * `Notification.Server`, not in the standard LSP protocol package, so there
 * is no ready-made type for it. This mirrors the field names of `overview`
 * in `protocol/lspWrapper.ml` exactly.
 */
interface UpdateHighlightsParams {
    uri: string;
    preparedRange: Range[];
    processingRange: Range[];
    processedRange: Range[];
}

const UpdateHighlightsNotification =
    new NotificationType<UpdateHighlightsParams>("prover/updateHighlights");

function positionsEqual(a: Position, b: Position): boolean {
    return a.line === b.line && a.character === b.character;
}

/**
 * The position `processedRange` reaches once `text` is fully checked.
 *
 * This is the end of the last line with content, not the LSP-standard
 * "one past the trailing newline" position: a `.v` file ending in `\n` has
 * nothing to check on the empty final line that newline would otherwise
 * open, and `processedRange` stops one line short of it (measured: an
 * 8-line fixture with a trailing newline settles at `7:28`, not `8:0`).
 */
export function endOfDocument(text: string): Position {
    const withoutTrailingNewline = text.endsWith("\n")
        ? text.slice(0, -1)
        : text;
    const lines = withoutTrailingNewline.split("\n");
    return {
        line: lines.length - 1,
        character: lines[lines.length - 1].length,
    };
}

/** Set by `useFixedServerArguments`, and `undefined` until it is called. */
let fixedArguments: string[] | undefined;

/**
 * Fixes the arguments every server started from here on is spawned with,
 * ignoring whatever `VSROCQARGS` holds.
 *
 * The golden half of the suite runs with this on: `golden/fixedArguments.ts`,
 * which `test:lsp:golden` loads through mocha's `--require` before any test
 * file, so it covers the goldens written later as much as today's.
 *
 * A golden freezes the server's answer verbatim, which means it has to freeze
 * what the server was started with too. Inheriting instead makes a golden
 * assert on the job that ran it: `install-opam` in `.github/workflows/ci.yml`
 * exports `VSROCQARGS: -bt` for the whole job, which appends a ~20-frame Rocq
 * backtrace to the text of every error, and the diagnostics golden below is
 * captured without one. It would fail on that job alone and pass everywhere
 * else, `nix-dev-build` included, which sets no `VSROCQARGS` at all.
 *
 * The structural half keeps inheriting the variable, and should: it asserts
 * on the shape of what comes back rather than on its text, and
 * `dev-setup-opam` passes the `-coqlib` its server cannot start without
 * through that same variable. `VSROCQPATH` is inherited either way — it
 * chooses which binary is under test, not what that binary prints.
 */
export function useFixedServerArguments(args: string[] = []): void {
    fixedArguments = args;
}

export function resolveVsrocqtop(): { command: string; args: string[] } {
    const command =
        process.env.VSROCQPATH ||
        path.resolve(
            __dirname,
            "../../../../language-server/_build/install/default/bin/vsrocqtop",
        );
    const args = fixedArguments ?? process.env.VSROCQARGS?.split(" ") ?? [];
    return { command, args };
}

/**
 * Compiles `<subdirectory>/<file>` to a `.vo`, so that another fixture in the
 * same directory can `Require` it.
 *
 * Some requests only ever answer about names that came from a compiled
 * library: `jump_to_definition` in `dm/queryManager.ml` returns a location
 * only for a `Loc.fname` of `InFile { dirpath = Some _ }`, and a name defined
 * in the buffer being edited is `ToplevelInput` instead. A fixture for one of
 * those needs two files, one of them already on the loadpath. The loadpath
 * itself comes from a `_RocqProject` next to them, which `vsrocqtop` reads on
 * `didOpen` by walking up from the opened file's directory
 * (`Args.get_local_args`, called from `open_new_document`).
 *
 * The `.vo` is built here rather than committed: it is not portable across
 * the Rocq versions the CI matrix covers, and it has to be readable by the
 * exact server under test. That is why the compiler is taken from the
 * directory `VSROCQPATH` points into whenever that variable is set. A `rocq`
 * found on `PATH` can belong to a different installation than the
 * `vsrocqtop` being driven, and a `.vo` built by one is rejected by the
 * other at `Require` time.
 *
 * `rocq compile` exists from Rocq 9.0 on, so this is usable from golden tests
 * (pinned to one Rocq version) but not from the version-independent ones.
 */
export async function compileFixture(
    subdirectory: string,
    logicalName: string,
    file: string,
): Promise<void> {
    const directory = path.join(fixturesDir, subdirectory);
    const { command } = resolveVsrocqtop();
    const sibling = path.join(path.dirname(command), "rocq");
    const compiler = existsSync(sibling) ? sibling : "rocq";

    const args = [
        "compile",
        "-R",
        directory,
        logicalName,
        path.join(directory, file),
    ];

    await new Promise<void>((resolve, reject) => {
        const child = cp.spawn(compiler, args, {
            stdio: ["ignore", "inherit", "inherit"],
        });
        const failed = (detail: string) =>
            reject(
                new Error(
                    `Could not build the fixture library this test requires: ` +
                        `${compiler} ${args.join(" ")} ${detail}. The library ` +
                        `is a prerequisite of the test, not part of what it ` +
                        `asserts.`,
                ),
            );

        child.once("error", (error) => failed(`could not be run (${error})`));
        child.once("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            failed(`exited with ${code}`);
        });
    });
}

/**
 * Drives one `vsrocqtop` process over stdio for the lifetime of a single
 * test. See `docs/adr/0001-protocol-level-test-safety-net.md` for why this
 * exists instead of extending the `@vscode/test-electron` suite.
 */
export class LspHarness {
    private readonly highlights = new Map<string, UpdateHighlightsParams>();
    private readonly waiters = new Map<string, Array<() => void>>();
    private nextVersion = 1;

    /**
     * Exposed directly (rather than wrapped) so that feature-specific tests
     * can send and observe their own requests and notifications, such as
     * `hover`, `documentSymbol`, or `prover/proofView`, without this file
     * having to grow a method per feature ahead of time.
     */
    readonly connection: ProtocolConnection;

    private constructor(
        private readonly child: cp.ChildProcessByStdio<
            Writable,
            Readable,
            null
        >,
        connection: ProtocolConnection,
    ) {
        this.connection = connection;
    }

    /** Spawns the server, completes the LSP handshake, and returns a ready harness. */
    static async start(
        settings: Settings = defaultSettings(),
    ): Promise<LspHarness> {
        const { command, args } = resolveVsrocqtop();
        const child = cp.spawn(command, args, {
            stdio: ["pipe", "pipe", "inherit"],
        });

        const connection = createProtocolConnection(child.stdout, child.stdin);
        const harness = new LspHarness(child, connection);

        connection.onRequest(ConfigurationRequest.type, (params) =>
            // vsrocqtop sends `workspace/configuration` once, right after
            // `initialize` returns (`send_configuration_request` in
            // lspManager.ml), and then discards the reply: the `Response`
            // case in its receive loop just logs "got unknown response". A
            // well-behaved client answers every request it receives
            // regardless, so this stays wired even though nothing downstream
            // reads it.
            params.items.map(() => settings),
        );

        connection.onNotification(UpdateHighlightsNotification, (params) => {
            harness.highlights.set(params.uri, params);
            for (const wake of harness.waiters.get(params.uri) ?? []) {
                wake();
            }
        });

        connection.listen();

        await connection.sendRequest(InitializeRequest.type, {
            processId: process.pid,
            rootUri: null,
            capabilities: {},
            initializationOptions: settings,
        });
        await connection.sendNotification(InitializedNotification.type, {});

        return harness;
    }

    /**
     * Opens a fixture from `client/src/test/lsp/fixtures/` under its own
     * URI and returns it. Unlike the Electron suite's `openFixture`, this
     * does not need to copy the file to a fresh path: a harness spawns one
     * `vsrocqtop` per test (per the ADR), so there is no shared server whose
     * per-URI state could leak between tests.
     */
    async openDocument(
        fixtureName: string,
    ): Promise<{ uri: string; text: string }> {
        const fsPath = path.join(fixturesDir, fixtureName);
        const text = await fs.readFile(fsPath, "utf-8");
        const uri = URI.file(fsPath).toString();

        const textDocument: TextDocumentItem = {
            uri,
            languageId: "rocq",
            version: this.nextVersion++,
            text,
        };
        await this.connection.sendNotification(
            DidOpenTextDocumentNotification.type,
            {
                textDocument,
            },
        );

        return { uri, text };
    }

    /**
     * Resolves once `uri` has been fully checked. The predicate is: both
     * `preparedRange` and `processingRange` empty, and the last span of
     * `processedRange` reaching the end of the document. "All three ranges
     * empty" is deliberately not used, since it is equally the state before
     * any work has started, and the permanent state in Manual mode.
     *
     * This predicate is only correct when `proof.block` is `false`
     * (`defaultSettings` sets it). With `block: true`, checking legitimately
     * stops at the first error and this call times out by design.
     */
    waitUntilChecked(
        uri: string,
        documentEnd: Position,
        timeoutMs = 10000,
    ): Promise<void> {
        const isReady = (
            params: UpdateHighlightsParams | undefined,
        ): boolean => {
            if (params === undefined) {
                return false;
            }
            const last =
                params.processedRange[params.processedRange.length - 1];
            return (
                params.preparedRange.length === 0 &&
                params.processingRange.length === 0 &&
                last !== undefined &&
                positionsEqual(last.end, documentEnd)
            );
        };

        if (isReady(this.highlights.get(uri))) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const wake = () => {
                if (!isReady(this.highlights.get(uri))) {
                    return;
                }
                clearTimeout(timer);
                const list = this.waiters.get(uri) ?? [];
                this.waiters.set(
                    uri,
                    list.filter((w) => w !== wake),
                );
                resolve();
            };

            const timer = setTimeout(() => {
                const list = this.waiters.get(uri) ?? [];
                this.waiters.set(
                    uri,
                    list.filter((w) => w !== wake),
                );
                reject(
                    new Error(
                        `Timed out after ${timeoutMs}ms waiting for ${uri} to finish ` +
                            `checking; last prover/updateHighlights: ` +
                            `${JSON.stringify(this.highlights.get(uri))}`,
                    ),
                );
            }, timeoutMs);

            this.waiters.set(uri, [...(this.waiters.get(uri) ?? []), wake]);
        });
    }

    /** Pushes a settings change, e.g. to switch a running server into Manual mode. */
    sendConfiguration(settings: Settings): Promise<void> {
        return this.connection.sendNotification(
            DidChangeConfigurationNotification.type,
            {
                settings,
            },
        );
    }

    /** Sends `shutdown` then `exit`, and waits for the process to actually end. */
    async shutdown(timeoutMs = 5000): Promise<void> {
        await this.connection.sendRequest(ShutdownRequest.type);
        await this.connection.sendNotification(ExitNotification.type);

        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.child.kill();
                resolve();
            }, timeoutMs);
            this.child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });

        this.connection.dispose();
    }
}
