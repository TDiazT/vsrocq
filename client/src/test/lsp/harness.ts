import * as cp from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";

import {
    ConfigurationRequest,
    Diagnostic,
    DidChangeConfigurationNotification,
    DidChangeTextDocumentNotification,
    DidOpenTextDocumentNotification,
    ExitNotification,
    InitializeRequest,
    InitializedNotification,
    NotificationType,
    Position,
    ProtocolConnection,
    PublishDiagnosticsNotification,
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
export interface UpdateHighlightsParams {
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
 * The offset of `position` in `text`, in UTF-16 code units — which is both
 * what LSP `Position.character` counts and what `String.prototype.slice`
 * indexes, so this needs no encoding caveat.
 *
 * Line endings are assumed to be `\n`. Every fixture in this suite uses them,
 * and `npm run test:lsp` is not run on Windows by any CI job (see
 * `.github/workflows/ci.yml`), so a CRLF checkout is not reachable.
 */
function offsetOf(text: string, position: Position): number {
    const lines = text.split("\n");
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
        offset += lines[line].length + 1;
    }
    return offset + position.character;
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
    private readonly diagnostics = new Map<string, Diagnostic[]>();
    private readonly texts = new Map<string, string>();
    private readonly highlightListeners: Array<
        (params: UpdateHighlightsParams) => void
    > = [];
    private readonly waiters = new Set<() => void>();
    private nextVersion = 1;

    /**
     * Exposed directly (rather than wrapped) so that feature-specific tests
     * can send and observe their own requests and notifications, such as
     * `hover`, `documentSymbol`, or `prover/proofView`, without this file
     * having to grow a method per feature ahead of time.
     *
     * One caveat, which cost real time to find: `connection.onNotification`
     * keeps **one** handler per method (`vscode-jsonrpc` stores them in a
     * `Map` keyed by method name), so registering a handler here for a method
     * the harness itself tracks silently replaces the harness's own. Doing
     * that for `prover/updateHighlights` leaves `waitUntilChecked` blind and
     * it times out reporting `last prover/updateHighlights: undefined`; doing
     * it for `textDocument/publishDiagnostics` leaves `latestDiagnostics` and
     * `waitForDiagnostics` seeing nothing. For the first, use `onHighlights`;
     * for the second, read `latestDiagnostics` or wait on
     * `waitForDiagnostics`.
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

    private wakeWaiters(): void {
        // Copied first: a waiter that resolves removes itself from the set.
        for (const wake of [...this.waiters]) {
            wake();
        }
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
            for (const listener of harness.highlightListeners) {
                listener(params);
            }
            harness.wakeWaiters();
        });

        connection.onNotification(
            PublishDiagnosticsNotification.type,
            (params) => {
                harness.diagnostics.set(params.uri, params.diagnostics);
                harness.wakeWaiters();
            },
        );

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
        this.texts.set(uri, text);

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
     * Sends one `textDocument/didChange` replacing `range` with `text`, and
     * returns the document as it now reads, together with the position
     * `processedRange` has to reach for it to count as fully checked again.
     *
     * The server declares `TextDocumentSyncKind.Incremental` and its
     * `textDocumentDidChange` does `Option.get range` on every content change
     * (`lspManager.ml`), so a whole-document change with no `range` is not
     * "also supported": it raises inside the server. Hence one range per call.
     *
     * The edit is applied to the harness's own copy of the text as well, so
     * that a test can chain edits without tracking the text itself.
     */
    async applyEdit(
        uri: string,
        range: Range,
        text: string,
    ): Promise<{ text: string; end: Position }> {
        const before = this.documentText(uri);
        const updated =
            before.slice(0, offsetOf(before, range.start)) +
            text +
            before.slice(offsetOf(before, range.end));
        this.texts.set(uri, updated);

        await this.connection.sendNotification(
            DidChangeTextDocumentNotification.type,
            {
                textDocument: { uri, version: this.nextVersion++ },
                contentChanges: [{ range, text }],
            },
        );

        return { text: updated, end: endOfDocument(updated) };
    }

    /** The current text of an open document, including every edit applied so far. */
    documentText(uri: string): string {
        const text = this.texts.get(uri);
        if (text === undefined) {
            throw new Error(`No open document for ${uri}`);
        }
        return text;
    }

    /**
     * Registers an additional observer of `prover/updateHighlights`, without
     * displacing the harness's own handler the way `connection.onNotification`
     * would (see the note on `connection`). Called for every notification,
     * including the repeats the server emits with identical payloads.
     */
    onHighlights(listener: (params: UpdateHighlightsParams) => void): void {
        this.highlightListeners.push(listener);
    }

    /** The most recent `publishDiagnostics` payload for `uri`, if any arrived. */
    latestDiagnostics(uri: string): Diagnostic[] | undefined {
        return this.diagnostics.get(uri);
    }

    /**
     * Resolves once `poll` returns something other than `undefined`.
     *
     * `poll` is evaluated immediately and then again on every
     * `prover/updateHighlights` and `textDocument/publishDiagnostics` the
     * harness receives — never on a timer. A test built on this cannot pass
     * because a machine was fast enough; only an actual server notification
     * can advance it. `describe` is only called to build the timeout message.
     */
    waitUntil<T>(
        poll: () => T | undefined,
        describe: () => string,
        timeoutMs = 10000,
    ): Promise<T> {
        const immediate = poll();
        if (immediate !== undefined) {
            return Promise.resolve(immediate);
        }

        return new Promise((resolve, reject) => {
            const wake = () => {
                const value = poll();
                if (value === undefined) {
                    return;
                }
                clearTimeout(timer);
                this.waiters.delete(wake);
                resolve(value);
            };

            const timer = setTimeout(() => {
                this.waiters.delete(wake);
                reject(
                    new Error(
                        `Timed out after ${timeoutMs}ms waiting for ${describe()}`,
                    ),
                );
            }, timeoutMs);

            this.waiters.add(wake);
        });
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
     *
     * It is also only correct on a document that has not been edited since it
     * was opened. After a `didChange`, use `waitUntilRechecked`.
     */
    async waitUntilChecked(
        uri: string,
        documentEnd: Position,
        timeoutMs = 10000,
    ): Promise<void> {
        await this.waitUntil(
            () => (this.isCheckedTo(uri, documentEnd) ? true : undefined),
            () =>
                `${uri} to finish checking; last prover/updateHighlights: ` +
                `${JSON.stringify(this.highlights.get(uri))}`,
            timeoutMs,
        );
    }

    /**
     * Resolves once `uri` has been re-checked following an edit.
     *
     * `waitUntilChecked` on its own returns immediately here and reports
     * success while the server is still working — finding V11. The
     * `prover/updateHighlights` that `textDocumentDidChange` emits
     * synchronously carries the *pre-edit* overview, shifted for the edit
     * (`CheckingManager.shift_overview`) but not truncated at it, with
     * `preparedRange` and `processingRange` empty. Nothing in its contents
     * distinguishes it from a genuine completion.
     *
     * What does distinguish it is its position in the sequence: the server
     * sends it before it has scheduled any parsing or checking, so every
     * notification reporting real progress comes after it. So this waits in two
     * stages — first for the server to report work in progress, which consumes
     * the stale notification, and only then for the readiness predicate. The
     * ordering is guaranteed by the server's own control flow
     * (`apply_text_edits`, then `update_view`, then the returned events), not
     * by timing.
     *
     * The first stage times out if the edit causes no work at all. That is
     * deliberate: an edit that triggers no re-checking has nothing for a
     * caller to wait for, and silently treating it as "re-checked" is how a
     * test ends up asserting against the pre-edit state.
     */
    async waitUntilRechecked(
        uri: string,
        documentEnd: Position,
        timeoutMs = 10000,
    ): Promise<void> {
        await this.waitUntil(
            () => {
                const params = this.highlights.get(uri);
                return params !== undefined &&
                    (params.preparedRange.length > 0 ||
                        params.processingRange.length > 0)
                    ? true
                    : undefined;
            },
            () =>
                `${uri} to show work in progress after an edit; last ` +
                `prover/updateHighlights: ` +
                `${JSON.stringify(this.highlights.get(uri))}`,
            timeoutMs,
        );
        await this.waitUntilChecked(uri, documentEnd, timeoutMs);
    }

    /**
     * Whether `params` (by default the latest one received for `uri`) reports
     * `uri` as checked all the way to `documentEnd`. This is the readiness
     * predicate itself, exposed so that a test can ask it of a specific
     * notification rather than of the latest state — which is what it takes to
     * assert that a stale post-edit notification could not have satisfied it.
     */
    isCheckedTo(
        uri: string,
        documentEnd: Position,
        params: UpdateHighlightsParams | undefined = this.highlights.get(uri),
    ): boolean {
        if (params === undefined) {
            return false;
        }
        const last = params.processedRange[params.processedRange.length - 1];
        return (
            params.preparedRange.length === 0 &&
            params.processingRange.length === 0 &&
            last !== undefined &&
            positionsEqual(last.end, documentEnd)
        );
    }

    /**
     * Resolves with the diagnostics for `uri` once they satisfy `predicate`.
     *
     * Two traps this does not paper over, both measured. A document with no
     * errors publishes `[]` from the first instant, so `d => d.length === 0`
     * is satisfied before any work happens. And after a `didChange` the server
     * publishes `[]` when it *invalidates* the edited sentences, before
     * re-checking them, so the same predicate is satisfied on a document that
     * did have an error and may well have it again. Waiting for the absence of
     * something is only meaningful once checking has been established to be
     * over by other means.
     */
    waitForDiagnostics(
        uri: string,
        predicate: (diagnostics: Diagnostic[]) => boolean,
        timeoutMs = 10000,
    ): Promise<Diagnostic[]> {
        return this.waitUntil(
            () => {
                const diagnostics = this.diagnostics.get(uri);
                return diagnostics !== undefined && predicate(diagnostics)
                    ? diagnostics
                    : undefined;
            },
            () =>
                `diagnostics on ${uri} to satisfy the test's predicate; ` +
                `last textDocument/publishDiagnostics: ` +
                `${JSON.stringify(this.diagnostics.get(uri))}`,
            timeoutMs,
        );
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
