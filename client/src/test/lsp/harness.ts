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
    // Every server this suite starts runs with the `diags_version` audit on.
    //
    // The server skips publishing diagnostics when a counter in
    // `dm/document.ml` says nothing the client could see has changed, and that
    // counter is maintained by hand at every site touching a sentence's
    // errors, messages or positions. With this flag the server recomputes the
    // diagnostics on each skipped publication and dies if they moved after
    // all. It is off by default because it costs precisely the work the
    // skipping saves; it is on here so that every test in this suite — these
    // and any written later — doubles as a check on the counter, which no
    // single hand-written sequence could be. See `audit_skipped_publication`
    // in `vsrocqtop/lspManager.ml`.
    return { command, args: [...args, "-vsrocq-d", "diags-version"] };
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

/** How the server process ended, recorded as soon as it does. */
interface ServerExit {
    code: number | null;
    signal: NodeJS.Signals | null;
    /** Time from spawn to exit, in milliseconds. */
    afterMs: number;
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
    private readonly startedAt = Date.now();
    private exit: ServerExit | undefined;

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

    /**
     * One clause describing the server process as it stands, for use in the
     * message of anything that gives up waiting on it.
     *
     * The distinction it draws — dead, and with which signal, versus alive and
     * not answering — is the whole point. Without it both arrive as the same
     * class of failure, and telling them apart was the crux of three separate
     * investigations into the SIGBUS crash before this existed.
     */
    private serverStatus(): string {
        if (this.exit === undefined) {
            return `vsrocqtop (pid ${this.child.pid}) is still running`;
        }
        const elapsed = `after ${(this.exit.afterMs / 1000).toFixed(1)}s`;
        return this.exit.signal !== null
            ? `vsrocqtop died with ${this.exit.signal} ${elapsed}`
            : `vsrocqtop exited with code ${this.exit.code} ${elapsed}`;
    }

    /**
     * Whether the server process is still alive, allowing a moment for an
     * exit that has happened but not yet been reported to this process.
     *
     * Exposed for `harness.test.ts`, which asserts on what the harness itself
     * does; a feature test has no use for it.
     */
    async isRunning(): Promise<boolean> {
        return !(await this.waitForExit(500));
    }

    /**
     * Resolves `true` once the server process has ended, or `false` if it is
     * still running `timeoutMs` later.
     */
    private waitForExit(timeoutMs: number): Promise<boolean> {
        if (this.exit !== undefined) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            const onExit = () => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                this.child.off("exit", onExit);
                resolve(false);
            }, timeoutMs);
            this.child.once("exit", onExit);
        });
    }

    /**
     * `promise`, but rejecting once `timeoutMs` has passed with no answer.
     *
     * The underlying promise is left pending rather than cancelled — nothing
     * in `vscode-jsonrpc` can withdraw a request that was already written to
     * the server. It holds no timer of its own, so it cannot keep the process
     * alive; and its eventual rejection when the connection is disposed is
     * absorbed by the handlers attached here rather than surfacing as an
     * unhandled rejection.
     */
    private withDeadline<T>(
        promise: Promise<T>,
        timeoutMs: number,
        what: string,
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () =>
                    reject(
                        new Error(
                            `${what} went unanswered for ${timeoutMs}ms; ` +
                                this.serverStatus(),
                        ),
                    ),
                timeoutMs,
            );
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
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

        // Recorded rather than acted on: a server death is reported by
        // whichever wait or request is left with nothing to wait for, which is
        // where the test actually is. Waking the waiters is what lets them do
        // that at once instead of sitting out their full timeout first.
        child.once("exit", (code, signal) => {
            harness.exit = {
                code,
                signal,
                afterMs: Date.now() - harness.startedAt,
            };
            harness.wakeWaiters();
        });

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

        try {
            await connection.sendRequest(InitializeRequest.type, {
                processId: process.pid,
                rootUri: null,
                capabilities: {},
                initializationOptions: settings,
            });
            await connection.sendNotification(InitializedNotification.type, {});
        } catch (error) {
            // A server that dies during the handshake — a `vsrocqtop` built
            // against the wrong Rocq, say — closes the connection, and
            // `Connection is closed` on its own does not say that a process
            // died, let alone of what. The wait is for the `exit` event to
            // catch up with the closed stream, and is bounded because the
            // connection can also close on a server that stays alive.
            await harness.waitForExit(1000);
            throw new Error(
                `The LSP handshake failed: ${error}; ${harness.serverStatus()}`,
            );
        }

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
     * can advance it. `describe` is only called to build the failure message.
     *
     * A server that has died ends the wait immediately, naming the signal,
     * rather than letting it run out the clock: nothing further can arrive
     * over a closed connection, and `Timed out after 10000ms` says none of
     * that. The poll is still evaluated first each time, so notifications that
     * arrived before the process ended are not lost to the race.
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
        if (this.exit !== undefined) {
            return Promise.reject(
                new Error(`${this.serverStatus()}, waiting for ${describe()}`),
            );
        }

        return new Promise((resolve, reject) => {
            const settle = () => {
                clearTimeout(timer);
                this.waiters.delete(wake);
            };

            const wake = () => {
                const value = poll();
                if (value !== undefined) {
                    settle();
                    resolve(value);
                    return;
                }
                if (this.exit !== undefined) {
                    settle();
                    reject(
                        new Error(
                            `${this.serverStatus()}, waiting for ${describe()}`,
                        ),
                    );
                }
            };

            const timer = setTimeout(() => {
                this.waiters.delete(wake);
                reject(
                    new Error(
                        `Timed out after ${timeoutMs}ms waiting for ` +
                            `${describe()}; ${this.serverStatus()}`,
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
     * Resolves once `uri` has been re-checked following an edit. Waits in two
     * stages: first for the server to report work in progress, and only then
     * for the readiness predicate.
     *
     * The first stage was originally the only thing making this trustworthy.
     * `waitUntilChecked` used to return immediately after a `didChange` and
     * report success while the server was still recomputing (finding V11): the
     * `prover/updateHighlights` that `textDocumentDidChange` emits
     * synchronously carried the pre-edit overview, shifted for the edit but not
     * truncated at it, and nothing in its contents distinguished it from a
     * genuine completion. What did distinguish it was its position in the
     * sequence — the server sends it before scheduling any parsing or checking
     * — so waiting for progress first consumed it. That is now fixed in
     * `CheckingManager.truncate_overview`, and the first notification reports
     * the document as checked only up to the edit.
     *
     * Both stages stay. The first now earns its place by failing loudly when an
     * edit causes no work at all, rather than letting a caller treat that as
     * "re-checked" and assert against the pre-edit state; and it keeps the
     * suite honest if the truncation ever regresses. The ordering it relies on
     * is a property of the server's control flow (`apply_text_edits`, then
     * `update_view`, then the returned events), not of timing.
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

    /**
     * Sends `shutdown` then `exit`, waits for the process to actually end,
     * and kills it if it will not.
     *
     * Every test calls this from a `finally`, which constrains what it may
     * throw: an error raised here replaces the one the test was already
     * failing with. So a server that has *died* is not reported from here at
     * all — the wait or request that first found the connection closed says
     * so, with the signal, from where the test actually was. This used to
     * throw `Connection is closed` over that.
     *
     * A server that is alive and no longer answering is reported to `report`
     * instead of thrown, for the same reason. Before the deadline below,
     * `shutdown` waited on a reply that would never come: the test had already
     * failed on mocha's own timeout, but the run never finished, and since npm
     * buffers a workspace script until it exits, `npm run test:lsp` printed
     * nothing at all — not the suite, not the test name, not the failure.
     * Killing the child is what ends the run. Throwing on top of that would
     * hand mocha a second outcome for a test it has already finished, which it
     * answers with `ERR_MOCHA_MULTIPLE_DONE` — and that aborts the process,
     * taking the remaining test files with it. The test that provoked the
     * wedge is named by its own failure; this line says what became of the
     * server afterwards.
     */
    async shutdown(
        timeoutMs = 2000,
        report: (message: string) => void = (message) =>
            process.stderr.write(message),
    ): Promise<void> {
        let wedged = false;

        if (this.exit === undefined) {
            try {
                await this.withDeadline(
                    this.connection.sendRequest(ShutdownRequest.type),
                    timeoutMs,
                    "`shutdown`",
                );
                await this.connection.sendNotification(ExitNotification.type);
            } catch {
                // Either the connection closed while we were asking, or the
                // request went unanswered. Which of the two it was is settled
                // by whether the process is gone, below.
            }

            wedged = !(await this.waitForExit(timeoutMs));
            if (wedged) {
                // SIGKILL rather than SIGTERM: a server that ignored
                // `shutdown` has already shown that it is not going to run
                // anything, and a second thing to wait for is the last thing
                // this needs.
                this.child.kill("SIGKILL");
                await this.waitForExit(timeoutMs);
            }
        }

        this.connection.dispose();

        if (wedged) {
            report(
                `\nvsrocqtop did not answer \`shutdown\` within ${timeoutMs}ms ` +
                    `and was still running, so the harness killed it with ` +
                    `SIGKILL. The server was wedged, not dead: a stack ` +
                    `overflow on the prover thread can leave it spinning at ` +
                    `100% CPU (see dm/proverThreadStubs.c).\n`,
            );
        }
    }
}
