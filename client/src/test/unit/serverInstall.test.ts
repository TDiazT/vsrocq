import { expect } from "expect";
import {
    advise,
    describeSwitch,
    dirOnPath,
    InstallAdvice,
    installCommand,
    installLines,
    installTargetFor,
    OpamFacts,
    satisfies,
    serverElsewhereLines,
    settingsCommandFor,
} from "../../utilities/serverInstall";

/**
 * Opam facts with nothing installed anywhere and no switch on PATH, so each
 * test states only the fact it is about.
 */
const opamFacts = (
    over: Partial<Extract<OpamFacts, { available: true }>> = {},
) =>
    ({
        available: true,
        switchName: "vsrocq-dev",
        rocqPresent: true,
        globalServer: null,
        windowSwitch: null,
        ...over,
    }) as OpamFacts;

describe("advise", () => {
    it("offers an install command built from the minimum server version, not the extension version", () => {
        // Extension 2.4.1 requires server >= 2.4.0: the two numbers differ, so
        // a command that merely echoed the extension version would pass a
        // same-number case and fail here.
        const advice = advise({
            extensionVersion: "2.4.1",
            serverVersion: null,
            configuredPath: null,
            opam: opamFacts({ switchName: "vsrocq-dev", rocqPresent: true }),
        });

        expect(advice).toEqual({
            kind: "offerInstall",
            required: "2.4.0",
            command: "opam install 'vsrocq-language-server>=2.4.0'",
            switchName: "vsrocq-dev",
            rocqPresent: true,
            windowSwitch: null,
        });
    });

    it("refuses to build a command for an extension version the map does not cover", () => {
        // 2.1.4 was released as a tag but has no row in versionRequirements.
        // Without this branch the bound is `undefined` and the command reads
        // "vsrocq-language-server>=undefined".
        const advice = advise({
            extensionVersion: "2.1.4",
            serverVersion: null,
            configuredPath: null,
            opam: opamFacts({ switchName: "vsrocq-dev", rocqPresent: true }),
        });

        expect(advice).toEqual({
            kind: "unknownExtensionVersion",
            extension: "2.1.4",
        });
    });

    it("suppresses the install offer when vsrocq.path pins an explicit binary", () => {
        // toolchain.ts prefers the configured path over PATH, so an opam
        // install would succeed and change nothing. Still report the bound,
        // so the message can say what the pinned binary has to satisfy.
        const advice = advise({
            extensionVersion: "2.4.1",
            serverVersion: null,
            configuredPath: "/opt/stale/bin/vsrocqtop",
            opam: opamFacts({ switchName: "vsrocq-dev", rocqPresent: true }),
        });

        expect(advice).toEqual({
            kind: "pathOverride",
            configured: "/opt/stale/bin/vsrocqtop",
            required: "2.4.0",
        });
    });

    it("stays quiet when the installed server already satisfies the bound", () => {
        // Extension 2.4.1 requires >= 2.4.0 and the server is 2.4.3. The
        // server version is deliberately neither the bound nor the extension
        // version, so only a real comparison passes.
        const advice = advise({
            extensionVersion: "2.4.1",
            serverVersion: "2.4.3",
            configuredPath: null,
            opam: opamFacts({ switchName: "vsrocq-dev", rocqPresent: true }),
        });

        expect(advice).toEqual({ kind: "serverOk" });
    });

    it("reports the bound but no command when opam is not usable", () => {
        // Q5: nix users and users without opam get the diagnosis and the
        // required version, never a button running a command that cannot work.
        // "notOnPath" and "absent" need different advice, so the reason is
        // carried through rather than collapsed to a boolean.
        const advice = advise({
            extensionVersion: "2.4.1",
            serverVersion: null,
            configuredPath: null,
            opam: { available: false, reason: "notOnPath" },
        });

        expect(advice).toEqual({
            kind: "noOpam",
            reason: "notOnPath",
            required: "2.4.0",
        });
    });

    // The two below are covered by branches already written, so neither failed
    // first. They are here because they are the cases the feature exists for.

    it("offers the install when the installed server is older than the bound", () => {
        // The drift case: the extension auto-updates in the editor, the opam
        // package does not, so this is the state most users land in.
        const advice = advise({
            extensionVersion: "2.4.1",
            serverVersion: "2.3.4",
            configuredPath: null,
            opam: opamFacts({ switchName: "vsrocq-dev", rocqPresent: true }),
        });

        expect(advice).toEqual({
            kind: "offerInstall",
            required: "2.4.0",
            command: "opam install 'vsrocq-language-server>=2.4.0'",
            switchName: "vsrocq-dev",
            rocqPresent: true,
            windowSwitch: null,
        });
    });

    it("still offers the install when the switch has no Rocq, flagging it", () => {
        // Q10: warn, do not refuse. Without a Rocq in the switch the command
        // silently becomes a multi-hour Rocq build, and the caller needs to be
        // able to say so before the user agrees to it.
        const advice = advise({
            extensionVersion: "2.4.1",
            serverVersion: null,
            configuredPath: null,
            opam: opamFacts({ switchName: "fresh-switch", rocqPresent: false }),
        });

        expect(advice).toEqual({
            kind: "offerInstall",
            required: "2.4.0",
            command: "opam install 'vsrocq-language-server>=2.4.0'",
            switchName: "fresh-switch",
            rocqPresent: false,
            windowSwitch: null,
        });
    });

    it("points at the server opam already has rather than offering to install it again", () => {
        // The case a user actually hit: PATH resolved into a switch with no
        // server while the selected switch had an adequate one all along, and
        // the extension offered to install what was already there.
        const advice = advise({
            extensionVersion: "2.4.1",
            serverVersion: null,
            configuredPath: null,
            opam: opamFacts({
                switchName: "rocq-9.2",
                globalServer: {
                    version: "2.4.3+1",
                    path: "/home/t/.opam/rocq-9.2/bin/vsrocqtop",
                },
                windowSwitch: { kind: "global", name: "vsrocq-819" },
            }),
        });

        expect(advice).toEqual({
            kind: "serverUnreachable",
            required: "2.4.0",
            switchName: "rocq-9.2",
            server: {
                version: "2.4.3+1",
                path: "/home/t/.opam/rocq-9.2/bin/vsrocqtop",
            },
            rocqPresent: true,
            windowSwitch: { kind: "global", name: "vsrocq-819" },
        });
    });

    it("offers the install when the selected switch's server is also too old", () => {
        // Having *a* server in the selected switch is not enough: pointing the
        // window at one below the bound would trade one failure for another.
        const advice = advise({
            extensionVersion: "2.4.1",
            serverVersion: null,
            configuredPath: null,
            opam: opamFacts({
                switchName: "rocq-9.2",
                globalServer: {
                    version: "2.3.4",
                    path: "/home/t/.opam/rocq-9.2/bin/vsrocqtop",
                },
                windowSwitch: { kind: "global", name: "vsrocq-819" },
            }),
        });

        expect(advice.kind).toBe("offerInstall");
    });

    it("prefers the running server over one opam knows about", () => {
        // serverOk has to win: a window that already resolved an adequate
        // server needs no modal, whatever the selected switch holds.
        const advice = advise({
            extensionVersion: "2.4.1",
            serverVersion: "2.4.0",
            configuredPath: null,
            opam: opamFacts({
                switchName: "rocq-9.2",
                globalServer: {
                    version: "2.4.3+1",
                    path: "/home/t/.opam/rocq-9.2/bin/vsrocqtop",
                },
            }),
        });

        expect(advice).toEqual({ kind: "serverOk" });
    });
});

describe("describeSwitch", () => {
    it("names a global switch", () => {
        expect(describeSwitch({ kind: "global", name: "rocq-9.2" })).toBe(
            "switch rocq-9.2",
        );
    });

    it("addresses a local switch by its prefix, which is all opam gives it", () => {
        expect(
            describeSwitch({ kind: "local", prefix: "/home/t/proj/_opam" }),
        ).toBe("the local switch at /home/t/proj/_opam");
    });
});

describe("installTargetFor", () => {
    it("offers the switch this window resolves through", () => {
        // A server installed there is found by which(), so it needs neither
        // vsrocq.path nor a restart.
        expect(installTargetFor({ kind: "global", name: "vsrocq-819" })).toBe(
            "vsrocq-819",
        );
    });

    it("offers a local switch by the directory opam addresses it as", () => {
        // opam takes the directory holding _opam; handed the _opam itself it
        // looks for a switch inside it and reports none installed.
        expect(
            installTargetFor({ kind: "local", prefix: "/home/t/proj" }),
        ).toBe("/home/t/proj");
    });

    it("refuses when the window resolves through no switch", () => {
        // An install would land somewhere this window cannot see either.
        expect(installTargetFor(null)).toBe(null);
    });
});

describe("serverElsewhereLines", () => {
    const server = {
        version: "2.4.3+1",
        path: "/home/t/.opam/rocq-9.2/bin/vsrocqtop",
    };
    const inWindow = { kind: "global", name: "vsrocq-819" } as const;
    const lines = (over = {}) =>
        serverElsewhereLines({
            switchName: "rocq-9.2",
            server,
            windowSwitch: inWindow,
            isGlobal: true,
            installTarget: null,
            ...over,
        });

    it("calls the selected switch global and does not offer opam switch set", () => {
        // The switch already is the selected one, so setting it would change
        // nothing. The restart is what stands between the two.
        expect(lines()[0]).toBe(
            "Your global switch rocq-9.2 has language server 2.4.3+1 installed. " +
                "This window looks for it in switch vsrocq-819, which it inherited when VS Code started.",
        );
        expect(lines()[1]).toBe(
            "Quit VS Code and start it again to pick up rocq-9.2, " +
                "or set vsrocq.path to /home/t/.opam/rocq-9.2/bin/vsrocqtop.",
        );
        expect(lines().join(" ")).not.toContain("opam switch set");
    });

    it("offers the global switch route only when the switch is not already it", () => {
        expect(lines({ isGlobal: false })[0]).toBe(
            "Switch rocq-9.2 has language server 2.4.3+1 installed. " +
                "This window looks for it in switch vsrocq-819, which it inherited when VS Code started.",
        );
        expect(lines({ isGlobal: false })[1]).toBe(
            "Set vsrocq.path to /home/t/.opam/rocq-9.2/bin/vsrocqtop to use it in this window, " +
                "or make rocq-9.2 your global switch with `opam switch set rocq-9.2` " +
                "and restart VS Code to use it everywhere.",
        );
    });

    it("names installing as a third fix, so the button is not the only mention", () => {
        // Two options joined by "or" become three joined by commas: the
        // sentence has to survive gaining one.
        expect(lines({ installTarget: "vsrocq-819" })[1]).toBe(
            "Quit VS Code and start it again to pick up rocq-9.2, " +
                "set vsrocq.path to /home/t/.opam/rocq-9.2/bin/vsrocqtop, " +
                "or install a server into switch vsrocq-819.",
        );
    });

    it("explains the window's switch whichever route named the other one", () => {
        // The clause answers "why is it looking there", which is asked just as
        // much after picking a switch as before.
        for (const isGlobal of [true, false]) {
            expect(lines({ isGlobal })[0]).toContain(
                "which it inherited when VS Code started",
            );
        }
    });

    it("states the bare fact when the window resolves into no switch", () => {
        expect(lines({ windowSwitch: null })[0]).toBe(
            "Your global switch rocq-9.2 has language server 2.4.3+1 installed. " +
                "This window has no opam switch active.",
        );
    });

    it("names a local switch by its prefix", () => {
        expect(
            lines({
                windowSwitch: { kind: "local", prefix: "/home/t/proj/_opam" },
            })[0],
        ).toContain("the local switch at /home/t/proj/_opam");
    });
});

describe("installCommand", () => {
    it("leaves the switch to the shell when none is chosen", () => {
        expect(installCommand("2.4.0", null)).toBe(
            "opam install 'vsrocq-language-server>=2.4.0'",
        );
    });

    it("pins the switch when one is chosen, so the shell cannot decide", () => {
        // Without --switch the command uses whatever the terminal's shell
        // resolves, which is not necessarily the switch this window detected.
        // Choosing one has to remove that ambiguity, not just describe it.
        expect(installCommand("2.4.0", "rocq-9.0")).toBe(
            "opam install --switch='rocq-9.0' 'vsrocq-language-server>=2.4.0'",
        );
    });
});

describe("satisfies", () => {
    it("accepts an opam revision of the required version", () => {
        // 2.4.3+1 is what opam publishes; a comparison that choked on the
        // suffix would call an adequate server inadequate.
        expect(satisfies("2.4.3+1", "2.4.0")).toBe(true);
    });

    it("rejects a server below the bound", () => {
        expect(satisfies("2.3.4", "2.4.0")).toBe(false);
    });
});

describe("dirOnPath", () => {
    it("finds a directory listed in PATH", () => {
        expect(
            dirOnPath(
                "/home/t/.opam/rocq-9.0/bin",
                "/usr/bin:/home/t/.opam/rocq-9.0/bin:/bin",
                ":",
            ),
        ).toBe(true);
    });

    it("is not fooled by a trailing slash on the PATH entry", () => {
        expect(
            dirOnPath(
                "/home/t/.opam/rocq-9.0/bin",
                "/usr/bin:/home/t/.opam/rocq-9.0/bin/",
                ":",
            ),
        ).toBe(true);
    });

    it("does not match a directory that merely shares a prefix", () => {
        // .../rocq-9.0/bin must not be satisfied by .../rocq-9.0/bin-old.
        expect(
            dirOnPath(
                "/home/t/.opam/rocq-9.0/bin",
                "/home/t/.opam/rocq-9.0/bin-old",
                ":",
            ),
        ).toBe(false);
    });

    it("survives the empty entries PATH often carries", () => {
        expect(dirOnPath("/a/bin", "::/a/bin:", ":")).toBe(true);
        expect(dirOnPath("/a/bin", "::", ":")).toBe(false);
    });
});

describe("installLines", () => {
    const offer = (over = {}) =>
        ({
            kind: "offerInstall",
            required: "2.4.0",
            command: "opam install 'vsrocq-language-server>=2.4.0'",
            switchName: "vsrocq-819",
            rocqPresent: true,
            windowSwitch: null,
            ...over,
        }) as Extract<InstallAdvice, { kind: "offerInstall" }>;

    const lines = (
        over = {},
        pinned: string | null = null,
        rocqPresent = true,
        bin: string | null = null,
    ) =>
        installLines({
            advice: offer(over),
            pinned,
            rocqPresent,
            pinnedBinDir: bin,
        });

    it("says where the window looks, as the other modals do", () => {
        // Without this the install modal was the only one that never named
        // the window's switch, so a later modal naming a different switch
        // read as a contradiction.
        expect(
            lines({ windowSwitch: { kind: "global", name: "rocq-9.0" } })[3],
        ).toBe(
            "This window looks for the server in switch rocq-9.0. " +
                "Running the command in the terminal installs it into your shell's switch, " +
                "so choose a switch to pin it to one instead.",
        );
    });

    it("says so plainly when the window resolves into no switch", () => {
        expect(lines()[3]).toBe(
            "This window has no opam switch active. " +
                "Running the command in the terminal installs it into your shell's switch, " +
                "so choose a switch to pin it to one instead.",
        );
    });

    it("labels a missing Rocq as the global switch's, not the window's", () => {
        // The two are different switches. Saying just "switch vsrocq-819"
        // invites the reader to match it against the window's switch named a
        // paragraph earlier.
        expect(lines({}, null, false)[4]).toBe(
            "Your global switch vsrocq-819 has no Rocq installed. " +
                "If your shell selects that switch, Rocq is built first, which can take a long time.",
        );
    });

    it("drops the condition once a switch is pinned, since the command names it", () => {
        expect(lines({}, "rocq-9.2", false)[3]).toBe(
            "Switch rocq-9.2 has no Rocq installed, so Rocq is built first, which can take a long time.",
        );
    });

    it('calls a local switch by its wording, not "switch /long/path"', () => {
        // opam names a local switch by a path, and a path reads as a path
        // rather than as a name wherever it is dropped into a sentence.
        const out = lines({}, "/home/t/proj", false);
        expect(out[1]).toBe(
            "The following command installs it into the local switch at /home/t/proj:",
        );
        expect(out[3]).toBe(
            "The local switch at /home/t/proj has no Rocq installed, so Rocq is built first, which can take a long time.",
        );
    });

    it("names the target in the lead-in rather than in a paragraph of its own", () => {
        // Reaching a pinned command means a switch was chosen, so restating
        // that the shell cannot override it is a paragraph the reader has
        // already lived through.
        expect(lines({}, "rocq-9.2")[1]).toBe(
            "The following command installs it into switch rocq-9.2:",
        );
        expect(lines({}, "rocq-9.2")[2]).toBe(
            "opam install --switch='rocq-9.2' 'vsrocq-language-server>=2.4.0'",
        );
        expect(lines({}, "rocq-9.2").join(" ")).not.toContain("pinned to");
    });

    it("leaves the lead-in unqualified while no switch is pinned", () => {
        expect(lines()[1]).toBe("The following command installs it with opam:");
    });

    it("says nothing about Rocq when opam reported no switch to name", () => {
        expect(lines({ switchName: null }, null, false)).toHaveLength(4);
    });

    it("does not lean on a pronoun where switch is the nearer noun", () => {
        // "install one into switch X" reads as installing a switch.
        for (const pinned of [null, "rocq-9.0"]) {
            expect(lines({}, pinned).join(" ")).not.toMatch(/\bone into\b/);
        }
    });

    it("says the install will be picked up when it targets the window's switch", () => {
        const out = lines(
            { windowSwitch: { kind: "global", name: "vsrocq-819" } },
            "vsrocq-819",
        );
        expect(out[out.length - 1]).toBe(
            "This window looks for the server in switch vsrocq-819, " +
                "so nothing else is needed once the install finishes.",
        );
    });

    it("says what is still needed when it targets some other switch", () => {
        // Installing elsewhere fixes nothing by itself, and learning that
        // after a Rocq build is the worst time to learn it.
        const out = lines(
            { windowSwitch: { kind: "global", name: "vsrocq-819" } },
            "rocq-9.0",
            true,
            "/home/t/.opam/rocq-9.0/bin",
        );
        expect(out[out.length - 1]).toBe(
            "This window looks for the server in switch vsrocq-819. " +
                "To use the server once it is installed, quit VS Code and start it again with rocq-9.0 active, " +
                "or set vsrocq.path to /home/t/.opam/rocq-9.0/bin/vsrocqtop.",
        );
    });

    it("still says what is needed when opam could not give the bin directory", () => {
        const out = lines({}, "rocq-9.0");
        expect(out[out.length - 1]).toBe(
            "This window has no opam switch active. " +
                "To use the server once it is installed, quit VS Code and start it again with rocq-9.0 active, " +
                "or set vsrocq.path to the vsrocqtop it installs.",
        );
    });

    it("adds nothing about afterwards while no switch is pinned", () => {
        // The modal is still asking for a pin, so there is no destination to
        // describe yet.
        expect(lines().join(" ")).not.toContain("once the install finishes");
    });
});

describe("settingsCommandFor", () => {
    it("reveals a workspace setting on the Workspace tab", () => {
        // openSettings always lands on the User tab, where a setting written
        // at workspace scope is not visible and reads as not written.
        expect(settingsCommandFor(true)).toBe(
            "workbench.action.openWorkspaceSettings",
        );
    });

    it("uses the plain settings command when there is no workspace to write to", () => {
        expect(settingsCommandFor(false)).toBe("workbench.action.openSettings");
    });
});
