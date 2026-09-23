import {
    commands,
    env,
    ExtensionContext,
    extensions,
    languages,
    MarkdownString,
    Selection,
    StatusBarAlignment,
    StatusBarItem,
    TextEditor,
    TextEditorRevealType,
    TextEditorSelectionChangeEvent,
    Uri,
    version,
    ViewColumn,
    window,
    workspace,
    WorkspaceEdit,
} from "vscode";

import {
    LanguageClientOptions,
    RequestType,
    ServerOptions,
    TextDocumentIdentifier,
} from "vscode-languageclient/node";

import Client from "./client";
import {
    getConfigurationOption,
    updateServerOnConfigurationChange,
} from "./configuration";
import { initializeDecorations } from "./Decorations";
import {
    sendInterpretToEnd,
    sendInterpretToPoint,
    sendInterrupt,
    sendStepBackward,
    sendStepForward,
} from "./manualChecking";
import { CommandKey } from "./package-json";
import { DocumentStateViewProvider } from "./panels/DocumentStateViewProvider";
import GoalPanel from "./panels/GoalPanel";
import SearchViewProvider from "./panels/SearchViewProvider";
import {
    DocumentProofsRequest,
    DocumentProofsResponse,
    ErrorAlertNotification,
    MoveCursorNotification,
    ProofViewNotification,
    ResetRocqRequest,
    ResetRocqResponse,
    RocqLogMessage,
    SearchRocqResult,
} from "./protocol/types";
import { QUICKFIX_COMMAND, RocqWarningQuickFix } from "./QuickFixProvider";
import { offerLanguageServerInstall } from "./utilities/installFlow";
import { openSetupGuide, SetupCheck } from "./utilities/setupCheck";
import VsRocqToolchainManager, {
    ToolchainError,
    ToolChainErrorCode,
} from "./utilities/toolchain";
import { checkVersion, getRocqdocUrl } from "./utilities/versioning";

let client: Client;

export function activate(context: ExtensionContext) {
    const getDocumentProofs = (uri: Uri) => {
        const textDocument = TextDocumentIdentifier.create(uri.toString());
        const params: DocumentProofsRequest = { textDocument };
        const req = new RequestType<
            DocumentProofsRequest,
            DocumentProofsResponse,
            void
        >("prover/documentProofs");
        Client.writeToVsrocqChannel("Getting proofs for: " + uri.toString());
        return client.sendRequest(req, params);
    };

    // VsCoq Legacy, for Rocq 8.17 and older.
    const LEGACY_ID = "coq-community.vscoq1";

    const setupCheck = new SetupCheck();
    const rocqTM = new VsRocqToolchainManager(setupCheck);
    // Set when vsrocq.path or vsrocq.args change while a server is running,
    // since that server keeps the old ones until the window reloads.
    let serverConfigChanged = false;
    // Set when the user starts the server from the setup check, so the start
    // is announced: the status bar item is the only other sign, and VS Code
    // hides it when the window is too narrow.
    let announceStart = false;
    // True from the moment startToolchain begins until the toolchain check
    // fails or the client has finished starting, so nothing offers a second
    // start meanwhile.
    let serverStarting = false;

    // The version the running server reported, or null while none is running.
    let serverVersion: string | null = null;

    // Toolchain discovery used to happen exactly once, so a user who fixed
    // their installation had no way back in short of reloading the window.
    // Naming it lets the install flow offer a Retry.
    const startToolchain = () => {
        if (client || serverStarting) {
            return;
        }
        serverStarting = true;
        const found = rocqTM.intialize();
        found.catch(() => {
            serverStarting = false;
        });
        found.then(
            () => {
                // A retry once the client is already up has nothing to do.
                if (client) {
                    return;
                }
                const serverOptions = rocqTM.getServerConfiguration();
                intializeExtension(serverOptions);
            },
            (err: ToolchainError) => {
                const notFound = err.status === ToolChainErrorCode.notFound;
                window
                    .showErrorMessage(
                        notFound
                            ? "No language server found"
                            : "Could not launch the language server",
                        { modal: true, detail: err.message },
                        ...(notFound
                            ? [
                                  {
                                      title: "Install the VsRocq language server (Recommended for Rocq >= 8.18)",
                                      id: 0,
                                  },
                              ]
                            : []),
                        { title: "Open setup guide", id: 2 },
                        {
                            title: "Install VsRocq Legacy (Required for Rocq <= 8.17)",
                            id: 1,
                        },
                    )
                    .then((act) => {
                        if (act?.id === 0) {
                            void offerLanguageServerInstall(
                                context,
                                null,
                                startToolchain,
                            );
                        }
                        if (act?.id === 2) {
                            openSetupGuide(err.step);
                        }
                        if (act?.id === 1) {
                            commands.executeCommand(
                                "extension.open",
                                LEGACY_ID,
                            );
                        }
                    });
            },
        );
    };

    context.subscriptions.push(
        commands.registerCommand("extension.rocq.installLanguageServer", () =>
            offerLanguageServerInstall(
                context,
                serverVersion,
                startToolchain,
                // Invoked deliberately from the palette, so say so even when
                // there is nothing wrong.
                true,
            ),
        ),
    );

    // These work before and without a language server, so a user whose
    // setup is broken can still reach the guide and the setup report.
    registerVsrocqCommand("walkthrough", () => {
        openSetupGuide();
    });
    registerVsrocqCommand("showLog", () => {
        Client.showLog();
    });
    registerVsrocqCommand("showSetup", async () => {
        let configString = getConfigString(
            client?.initializeResult?.serverInfo,
        );
        if (client?.initializeResult === undefined) {
            // Awaited: right after activation no check has finished yet.
            const { message } = setupCheck.describe(await setupCheck.run());
            const state = serverStarting
                ? "The language server is starting."
                : "The language server is not running.";
            configString += `\n\n${state} ${message}`;
        }
        window
            .showInformationMessage(
                configString,
                { modal: true },
                { title: "Copy to clipboard", id: 0 },
            )
            .then((act) => {
                if (act?.id === 0) {
                    env.clipboard.writeText(configString);
                }
            });
    });

    registerVsrocqCommand("checkSetup", async () => {
        const status = await setupCheck.run();
        const { ok, message } = setupCheck.describe(status);
        const running = client?.initializeResult !== undefined;
        // A client that exists but never initialized failed to start, and
        // startToolchain will not replace it.
        const failedToStart =
            client !== undefined && !running && !serverStarting;
        const lines = [message];
        const actions: string[] = [];
        if (ok && serverStarting) {
            lines.push("The language server is starting.");
        } else if (ok && failedToStart) {
            lines.push(
                "The language server did not start; reload the window to try again.",
            );
            actions.push("Reload window");
        } else if (ok && !running) {
            actions.push("Start language server");
        } else if (ok && serverConfigChanged) {
            lines.push(
                "The running language server still uses the old settings; reload the window to restart it.",
            );
            actions.push("Reload window");
        } else if (ok) {
            lines.push(
                setupCheck.compat?.message ??
                    "No server version requirement is known for this extension version, so the server version was not checked.",
            );
        }
        if (!ok) {
            actions.push("Show log");
        }
        const text = lines.join(" ");
        const shown =
            ok && setupCheck.compat?.ok !== false
                ? window.showInformationMessage(text, ...actions)
                : window.showWarningMessage(text, ...actions);
        // Not awaited: a notification stays pending until dismissed.
        shown.then((act) => {
            if (act === "Start language server") {
                announceStart = true;
                startToolchain();
            }
            if (act === "Reload window") {
                commands.executeCommand("workbench.action.reloadWindow");
            }
            if (act === "Show log") {
                Client.showLog();
            }
        });
        return status;
    });

    context.subscriptions.push(
        workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration("vsrocq.path") ||
                event.affectsConfiguration("vsrocq.args")
            ) {
                if (client?.initializeResult !== undefined) {
                    serverConfigChanged = true;
                }
                commands.executeCommand("extension.rocq.checkSetup");
            }
        }),
    );

    startToolchain();

    // Detect if VsCoq Legacy is installed and active
    const legacy = extensions.getExtension(LEGACY_ID);
    if (legacy) {
        if (legacy.isActive) {
            const message =
                "VsRocq is incompatible with VsCoq Legacy. Disable one of them.";
            window
                .showErrorMessage(
                    message,
                    { title: "Disable VsCoq Legacy", id: 0 },
                    { title: "Disable VsRocq", id: 1 },
                )
                .then((act) => {
                    if (act?.id === 0) {
                        commands.executeCommand("extension.open", LEGACY_ID);
                    }
                    if (act?.id === 1) {
                        commands.executeCommand(
                            "extension.open",
                            "rocq-prover.vsrocq",
                        );
                    }
                });
        }
    }

    const getConfigString = (serverInfo: any) => {
        const clean_strings = (str: string | undefined) => {
            // Properly escape backticks and pipes in the string, replace newlines with spaces
            return (str ?? "not available")
                .replace(/`/g, "\\`")
                .replace(/\|/g, "\\|")
                .replace(/\n/g, " ");
        };
        return `| Debug Information | Value |
| ----------------- | -------------------------------- |
| Rocq Installation | ${clean_strings(rocqTM.getversionFullOutput())} |
| Rocq Path         | \`${clean_strings(rocqTM.getRocqPath())}\` |
| VsRocq Extension Version   | ${clean_strings(extensions.getExtension("rocq-prover.vsrocq")?.packageJSON.version)} |
| VsRocqTop Version | ${clean_strings(serverInfo?.version)} |
| VsRocqTop Path  | \`${clean_strings(rocqTM.getVsRocqTopPath())}\` |
| OS               | ${process.arch} ${process.platform} |
| VSCode Version | ${version} |
`;
    };

    function registerVsrocqTextCommand<C extends string>(
        command: `extension.rocq.${C}` extends CommandKey ? C : never,
        callback: (textEditor: TextEditor, ...args: any[]) => void,
    ) {
        context.subscriptions.push(
            commands.registerTextEditorCommand(
                "extension.rocq." + command,
                callback,
            ),
        );
    }

    function registerVsrocqCommand<C extends string>(
        command: `extension.rocq.${C}` extends CommandKey ? C : never,
        callback: (...args: any[]) => unknown,
    ) {
        context.subscriptions.push(
            commands.registerCommand("extension.rocq." + command, callback),
        );
    }

    function intializeExtension(serverOptions: ServerOptions) {
        const config = getConfigurationOption();

        let clientOptions: LanguageClientOptions = {
            documentSelector: [{ scheme: "file", language: "rocq" }],
            initializationOptions: config,
        };

        // Create the language client and start the client.
        client = new Client(serverOptions, clientOptions);

        //register the search view provider
        const searchProvider = new SearchViewProvider(
            context.extensionUri,
            client,
        );
        context.subscriptions.push(
            window.registerWebviewViewProvider(
                SearchViewProvider.viewType,
                searchProvider,
            ),
        );

        const documentStateProvider = new DocumentStateViewProvider(client);
        context.subscriptions.push(
            workspace.registerTextDocumentContentProvider(
                "vsrocq-document-state",
                documentStateProvider,
            ),
        );

        //status bar item for showing rocq version and language server version
        const statusBar: StatusBarItem = window.createStatusBarItem(
            StatusBarAlignment.Right,
            1000,
        );
        context.subscriptions.push(statusBar);

        const launchQuery = (editor: TextEditor, type: string) => {
            const selection = editor.selection;
            const { end, start } = selection;
            if (end.line !== start.line) {
                return;
            } //don't allow for multiline selections
            //either use the user selection or if no selection than infer the word under the cursor
            const wordAtCurorRange =
                end.character !== start.character
                    ? selection
                    : editor.document.getWordRangeAtPosition(end);
            //focus on the query panel
            commands.executeCommand("vsrocq.search.focus");
            //open a prompt with the given word as default
            window
                .showInputBox({
                    prompt: type.charAt(0).toUpperCase() + type.slice(1),
                    value: wordAtCurorRange
                        ? editor.document.getText(wordAtCurorRange)
                        : undefined,
                })
                .then((queryText) => {
                    //launch the query
                    if (queryText) {
                        searchProvider.launchQuery(queryText, type);
                    }
                });
        };

        registerVsrocqTextCommand("reset", (editor) => {
            const uri = editor.document.uri;
            const textDocument = TextDocumentIdentifier.create(uri.toString());
            const params: ResetRocqRequest = { textDocument };
            const req = new RequestType<
                ResetRocqRequest,
                ResetRocqResponse,
                void
            >("prover/resetRocq");
            Client.writeToVsrocqChannel(uri.toString());
            client.sendRequest(req, params).then(
                (res) => {
                    GoalPanel.resetGoalPanel();
                },
                (err) => {
                    window.showErrorMessage(err);
                },
            );
        });
        registerVsrocqTextCommand("query.search", (editor) =>
            launchQuery(editor, "search"),
        );
        registerVsrocqTextCommand("query.about", (editor) =>
            launchQuery(editor, "about"),
        );
        registerVsrocqTextCommand("query.check", (editor) =>
            launchQuery(editor, "check"),
        );
        registerVsrocqTextCommand("query.locate", (editor) =>
            launchQuery(editor, "locate"),
        );
        registerVsrocqTextCommand("query.print", (editor) =>
            launchQuery(editor, "print"),
        );
        registerVsrocqTextCommand("addQueryTab", () => searchProvider.addTab());
        registerVsrocqTextCommand("collapseAllQueries", () =>
            searchProvider.collapseAll(),
        );
        registerVsrocqTextCommand("expandAllQueries", () =>
            searchProvider.expandAll(),
        );
        registerVsrocqTextCommand("interrupt", (editor) =>
            sendInterrupt(editor, client),
        );
        registerVsrocqTextCommand("interpretToPoint", (editor) =>
            sendInterpretToPoint(editor, client),
        );
        registerVsrocqTextCommand("interpretToEnd", (editor) =>
            sendInterpretToEnd(editor, client),
        );
        registerVsrocqTextCommand("stepForward", (editor) =>
            sendStepForward(editor, client),
        );
        registerVsrocqTextCommand("stepBackward", (editor) =>
            sendStepBackward(editor, client),
        );
        registerVsrocqTextCommand("documentState", async (editor) => {
            documentStateProvider.setDocumentUri(editor.document.uri);

            const document = await workspace.openTextDocument(
                documentStateProvider.uri,
            );

            documentStateProvider.fire();

            await window.showTextDocument(document, {
                viewColumn: ViewColumn.Two,
                preserveFocus: true,
            });
        });
        registerVsrocqTextCommand("showManual", () => {
            const url = getRocqdocUrl(rocqTM.getRocqVersion());
            commands.executeCommand("simpleBrowser.show", url);
        });
        registerVsrocqTextCommand("displayProofView", () => {
            const editor = window.activeTextEditor
                ? window.activeTextEditor
                : window.visibleTextEditors[0];
            GoalPanel.displayProofView(context.extensionUri, editor);
        });

        client.onNotification("prover/updateHighlights", (notification) => {
            client.saveHighlights(
                notification.uri,
                notification.preparedRange,
                notification.processingRange,
                notification.processedRange,
            );

            client.updateHightlights();
        });

        client.onNotification(
            "prover/moveCursor",
            (notification: MoveCursorNotification) => {
                const { uri, range } = notification;
                const editors = window.visibleTextEditors.filter((editor) => {
                    return editor.document.uri.toString() === uri.toString();
                });
                if (
                    getConfigurationOption("proof", "cursor", "sticky") ===
                        true ||
                    getConfigurationOption("proof", "mode") === 1
                ) {
                    editors.map((editor) => {
                        editor.selections = [
                            new Selection(range.end, range.end),
                        ];
                        editor.revealRange(range, TextEditorRevealType.Default);
                    });
                }
            },
        );

        client.onNotification(
            "prover/searchResult",
            (searchResult: SearchRocqResult) => {
                searchProvider.renderSearchResult(searchResult);
            },
        );

        client.onNotification(
            "prover/proofView",
            (proofView: ProofViewNotification) => {
                const editor = window.activeTextEditor
                    ? window.activeTextEditor
                    : window.visibleTextEditors[0];
                const autoDisplay = getConfigurationOption("goals", "auto");
                GoalPanel.proofViewNotification(
                    context.extensionUri,
                    editor,
                    proofView,
                    autoDisplay,
                );
            },
        );

        client.onNotification(
            "prover/blockOnError",
            (notification: ErrorAlertNotification) => {
                const { uri, range } = notification;
                client.createErrorAnimation(uri.toString(), [range]);
            },
        );

        client.onNotification(
            "prover/debugMessage",
            (rocqMessage: RocqLogMessage) => {
                const { message } = rocqMessage;
                const messageString = `${message}`;
                Client.writeRocqMessageLog(messageString);
            },
        );

        context.subscriptions.push(
            commands.registerCommand(QUICKFIX_COMMAND, (data) => {
                const { text, range, document } = data;
                const edit = new WorkspaceEdit();
                edit.replace(document.uri, range, text);
                workspace.applyEdit(edit);
            }),
        );
        languages.registerCodeActionsProvider(
            "rocq",
            new RocqWarningQuickFix(),
            {
                providedCodeActionKinds:
                    RocqWarningQuickFix.providedCodeActionKinds,
            },
        );

        const started = client.start();
        started
            .finally(() => {
                serverStarting = false;
            })
            .catch(() => undefined);
        started.then(() => {
            const compat = checkVersion(client, context);
            if (compat) {
                setupCheck.recordCompat(compat);
            }
            const serverInfo = client.initializeResult!.serverInfo;
            serverVersion = serverInfo?.version ?? null;
            // Q3(b): the drift case. The extension auto-updates in the editor
            // while the opam package does not, so a server that was fine
            // yesterday can be behind today. Says nothing when it is not.
            void offerLanguageServerInstall(
                context,
                serverVersion,
                startToolchain,
            );
            const configString = new MarkdownString(
                `**Rocq Installation**

${rocqTM.getversionFullOutput()}

Path: \`${rocqTM.getRocqPath()}\`
---

**vsrocqtop** ${serverInfo?.version}

Path: \`${rocqTM.getVsRocqTopPath()}\`
`,
            );
            statusBar.text = `${serverInfo?.name} ${serverInfo?.version}, rocq ${rocqTM.getRocqVersion()}`;
            statusBar.tooltip = configString;
            statusBar.show();
            if (announceStart) {
                announceStart = false;
                window.showInformationMessage(
                    `The language server started: ${statusBar.text}.`,
                );
            }

            initializeDecorations(context);

            // I think vscode should handle this automatically, TODO: try again after implemeting client capabilities
            context.subscriptions.push(
                workspace.onDidChangeConfiguration((event) => {
                    updateServerOnConfigurationChange(event, client);

                    if (event.affectsConfiguration("vsrocq.proof.mode")) {
                        client.resetHighlights();
                        client.updateHightlights();
                    }

                    GoalPanel.configurationChanged();
                }),
            );

            let goalsHook = window.onDidChangeTextEditorSelection(
                (evt: TextEditorSelectionChangeEvent) => {
                    if (
                        evt.textEditor.document.languageId === "rocq" &&
                        getConfigurationOption("proof", "mode") === 1
                    ) {
                        sendInterpretToPoint(evt.textEditor, client);
                    }
                },
            );

            window.onDidChangeActiveTextEditor((editor) => {
                client.updateHightlights();
            });
        });

        context.subscriptions.push(client);
    }

    const externalApi = {
        getDocumentProofs,
        onProofStateChanged: GoalPanel.onProofStateChanged,
    };

    return externalApi;
}

// This method is called when your extension is deactivated
export function deactivate() {}
