import { join } from "node:path";
import {
    commands,
    ConfigurationTarget,
    env,
    ExtensionContext,
    Uri,
    window,
    workspace,
} from "vscode";
import { getConfigurationOption } from "../configuration";
import { listSwitches, probeOpam, probeSwitch, SwitchFacts } from "./opamProbe";
import {
    advise,
    Facts,
    InstallAdvice,
    installCommand,
    installLines,
    installTargetFor,
    satisfies,
    serverElsewhereLines,
    settingsCommandFor,
} from "./serverInstall";

const INSTALL_DOCS =
    "https://github.com/rocq-prover/vsrocq?tab=readme-ov-file#installing-the-language-server";

const DOCS_BUTTON = { title: "Installation instructions", id: 0 };

/**
 * Collects what `advise` needs. The only impure step is the opam probe; the
 * rest is read straight off the extension and the configuration.
 */
export async function gatherFacts(
    context: ExtensionContext,
    serverVersion: string | null,
): Promise<Facts> {
    const configured = getConfigurationOption("path") as string;
    return {
        extensionVersion: context.extension.packageJSON.version,
        serverVersion,
        configuredPath: configured ? configured : null,
        opam: await probeOpam(workspace.rootPath),
    };
}

const NO_OPAM_REASON: Record<string, string> = {
    absent: "opam was not found on this machine.",
    notOnPath:
        "opam is installed but is not on the PATH this window inherited. Launching VS Code from a shell where `opam --version` works usually fixes it.",
    unusable:
        "opam was found but did not answer, which is what an opam root that has never been initialised does. Try `opam init`.",
};

/**
 * Puts the command in a terminal without running it.
 *
 * A terminal rather than a background exec because the build can take minutes
 * and this keeps it inspectable and interruptible. Left unexecuted because the
 * terminal's shell profile is what finally decides the opam switch, and the
 * user cannot check that -- or edit the command -- if it has already started.
 * Completion still cannot be observed, hence Retry rather than a restart.
 */
function openInTerminal(command: string, onRetry: () => void): void {
    const terminal = window.createTerminal("VsRocq: language server");
    terminal.show();
    terminal.sendText(command, false);

    window
        .showInformationMessage(
            "The command is waiting in the terminal, not yet running. Check it, press Enter to run it, and retry when it finishes.",
            { title: "Retry", id: 0 },
        )
        .then((act) => {
            if (act?.id === 0) {
                onRetry();
            }
        });
}

/**
 * Lets the user pin the switch. Returns null for "leave it to the shell",
 * undefined when the pick was cancelled.
 */
async function pickSwitch(
    current: string | null,
): Promise<string | null | undefined> {
    const switches = await listSwitches(workspace.rootPath);
    if (switches === null || switches.length === 0) {
        window.showWarningMessage("opam listed no switches to choose from.");
        return undefined;
    }

    const LEAVE = "Let my shell decide (do not pin a switch)";
    const picked = await window.showQuickPick([LEAVE, ...switches], {
        title: "opam switch to install into",
        placeHolder:
            current === null
                ? "No switch pinned"
                : `Currently pinned: ${current}`,
    });

    if (picked === undefined) {
        return undefined;
    }
    return picked === LEAVE ? null : picked;
}

/**
 * Writes vsrocq.path, then shows it.
 *
 * The setting outlives the problem it solves: from then on it wins over PATH,
 * including once the environment is fixed, and `pathOverride` is the modal a
 * user meets when the binary it names has fallen behind. Opening settings on
 * the key leaves that visible and undoable rather than buried.
 */
async function useServerAt(
    serverPath: string,
    onRetry: () => void,
): Promise<void> {
    // Workspace scope keeps the setting next to the project it was chosen for,
    // but there is nowhere to put it without a folder open.
    const workspaceScope = (workspace.workspaceFolders?.length ?? 0) > 0;
    await workspace
        .getConfiguration("vsrocq")
        .update(
            "path",
            serverPath,
            workspaceScope
                ? ConfigurationTarget.Workspace
                : ConfigurationTarget.Global,
        );
    // Settings opens on the User tab whichever scope was written, so the
    // setting we just made is off-screen behind the Workspace tab unless the
    // command matches where it went.
    await commands.executeCommand(
        settingsCommandFor(workspaceScope),
        "vsrocq.path",
    );
    onRetry();
}

/**
 * opam has a server good enough already and this window resolves elsewhere.
 * Nothing needs installing, so the modal is about reaching what is there.
 */
async function offerUnreachableServer(
    advice: Extract<InstallAdvice, { kind: "serverUnreachable" }>,
    onRetry: () => void,
): Promise<void> {
    // Choosing some other switch cannot help here: a server installed into a
    // third switch is no more reachable than the one that already exists. The
    // switch this window resolves through is the exception, and the only one
    // worth offering.
    const target = installTargetFor(advice.windowSwitch);

    const act = await window.showWarningMessage(
        "This window is not using your installed language server",
        {
            modal: true,
            detail: serverElsewhereLines({
                switchName: advice.switchName,
                server: advice.server,
                windowSwitch: advice.windowSwitch,
                isGlobal: true,
                installTarget: target,
            }).join("\n\n"),
        },
        { title: "Set vsrocq.path", id: 0 },
        ...(target === null
            ? []
            : [{ title: "Install into this window's switch", id: 1 }]),
    );

    if (act?.id === 0) {
        await useServerAt(advice.server.path, onRetry);
    }
    if (act?.id === 1 && target !== null) {
        await offerInstall(
            {
                kind: "offerInstall",
                required: advice.required,
                command: installCommand(advice.required, target),
                switchName: advice.switchName,
                rocqPresent: advice.rocqPresent,
                windowSwitch: advice.windowSwitch,
            },
            onRetry,
            target,
        );
    }
}

async function offerInstall(
    advice: Extract<InstallAdvice, { kind: "offerInstall" }>,
    onRetry: () => void,
    initialPin: string | null = null,
): Promise<void> {
    // null means no --switch, i.e. whatever the terminal's shell resolves.
    let pinned: string | null = initialPin;
    let rocqPresent = advice.rocqPresent;
    // What opam knows about the pinned switch, once one is picked.
    let facts: SwitchFacts | null = null;

    /** The pick and what opam says about it, or null when it was cancelled. */
    const pickAnother = async (): Promise<{
        pinned: string | null;
        facts: SwitchFacts | null;
        rocqPresent: boolean;
    } | null> => {
        const picked = await pickSwitch(pinned);
        if (picked === undefined) {
            return null;
        }
        const pickedFacts =
            picked === null
                ? null
                : await probeSwitch(picked, workspace.rootPath);
        return {
            pinned: picked,
            facts: pickedFacts,
            rocqPresent:
                picked === null
                    ? advice.rocqPresent
                    : pickedFacts === null || pickedFacts.rocqVersion !== null,
        };
    };

    if (initialPin !== null) {
        facts = await probeSwitch(initialPin, workspace.rootPath);
        rocqPresent = facts === null || facts.rocqVersion !== null;
    }

    for (;;) {
        const command = installCommand(advice.required, pinned);

        const binDir = facts?.binDir ?? null;
        const serverPath = binDir === null ? null : join(binDir, "vsrocqtop");
        const there = facts?.serverVersion ?? null;

        // Picking a switch that already has an adequate server is worth saying
        // out loud: opam would print "already installed" and do nothing, which
        // teaches the user nothing. The command is not offered, because there
        // is nothing for it to do.
        if (
            pinned !== null &&
            there !== null &&
            serverPath !== null &&
            satisfies(there, advice.required)
        ) {
            const act = await window.showWarningMessage(
                "That switch already has the language server",
                {
                    modal: true,
                    detail: serverElsewhereLines({
                        switchName: pinned,
                        server: { version: there, path: serverPath },
                        windowSwitch: advice.windowSwitch,
                        // Picking the selected switch is a real possibility,
                        // and makes the make-it-global advice a no-op.
                        isGlobal: pinned === advice.switchName,
                        // Choose switch... is already on this modal, so the
                        // window's switch is one pick away rather than a
                        // third button.
                        installTarget: null,
                    }).join("\n\n"),
                },
                { title: "Set vsrocq.path", id: 0 },
                { title: "Choose switch...", id: 1 },
            );

            if (act?.id === 1) {
                const pick = await pickAnother();
                if (pick === null) {
                    return;
                }
                ({ pinned, facts, rocqPresent } = pick);
                continue;
            }
            if (act?.id === 0) {
                await useServerAt(serverPath, onRetry);
            }
            return;
        }

        const lines = installLines({
            advice,
            pinned,
            rocqPresent,
            pinnedBinDir: binDir,
        });

        const act = await window.showWarningMessage(
            "Install the VsRocq language server?",
            { modal: true, detail: lines.join("\n\n") },
            { title: "Open in terminal", id: 0 },
            { title: "Choose switch...", id: 1 },
            { title: "Copy command", id: 2 },
        );

        if (act?.id === 1) {
            const pick = await pickAnother();
            if (pick === null) {
                return;
            }
            ({ pinned, facts, rocqPresent } = pick);
            continue;
        }
        if (act?.id === 0) {
            openInTerminal(command, onRetry);
        }
        if (act?.id === 2) {
            await env.clipboard.writeText(command);
            window.showInformationMessage(
                "Install command copied to the clipboard.",
            );
        }
        return;
    }
}

function openDocs(): void {
    commands.executeCommand("vscode.open", Uri.parse(INSTALL_DOCS));
}

export async function present(
    advice: InstallAdvice,
    onRetry: () => void,
    announceOk: boolean,
): Promise<void> {
    switch (advice.kind) {
        case "serverOk":
            if (announceOk) {
                window.showInformationMessage(
                    "The installed language server already meets this extension's requirement.",
                );
            }
            return;

        case "unknownExtensionVersion":
            window
                .showWarningMessage(
                    `No known language server requirement for VsRocq ${advice.extension}.`,
                    {
                        modal: true,
                        detail: "This extension build is not in the compatibility table, so the required server version cannot be determined. Install the language server matching this extension's version.",
                    },
                    DOCS_BUTTON,
                )
                .then((act) => act?.id === 0 && openDocs());
            return;

        case "pathOverride":
            window
                .showWarningMessage(
                    "vsrocq.path is set, so installing would change nothing.",
                    {
                        modal: true,
                        detail: `The setting points at ${advice.configured}, which wins over anything on PATH. That binary has to be language server ${advice.required} or newer. Clear the setting to use a server installed through opam.`,
                    },
                    { title: "Open settings", id: 0 },
                )
                .then(
                    (act) =>
                        act?.id === 0 &&
                        commands.executeCommand(
                            "workbench.action.openSettings",
                            "vsrocq.path",
                        ),
                );
            return;

        case "noOpam":
            window
                .showWarningMessage(
                    `This extension needs language server ${advice.required} or newer.`,
                    {
                        modal: true,
                        detail: `${NO_OPAM_REASON[advice.reason]}\n\nInstall the language server yourself, then reload the window.`,
                    },
                    DOCS_BUTTON,
                )
                .then((act) => act?.id === 0 && openDocs());
            return;

        case "serverUnreachable":
            return offerUnreachableServer(advice, onRetry);

        case "offerInstall":
            return offerInstall(advice, onRetry);
    }
}

/** Entry point for both the failure paths and the palette command. */
export async function offerLanguageServerInstall(
    context: ExtensionContext,
    serverVersion: string | null,
    onRetry: () => void,
    announceOk = false,
): Promise<void> {
    const facts = await gatherFacts(context, serverVersion);
    await present(advise(facts), onRetry, announceOk);
}
