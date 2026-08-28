import { expect } from "expect";
import {
    parseInstalledVersion,
    parseSwitchList,
    parseSwitchName,
    rocqPresentIn,
    switchPrefixOnPath,
    switchRefForPrefix,
} from "../../utilities/opamProbe";

// Captured verbatim from opam 2.x. Both cases exit 0, so the exit code says
// nothing and the output has to be read.
const WITH_ROCQ = `# Packages matching: (name-match(rocq-core) | name-match(coq-core)) & installed
# Name    # Installed # Synopsis
rocq-core 9.2.0       The Rocq Prover with its prelude
`;

const WITHOUT_ROCQ = `# Packages matching: (name-match(rocq-core) | name-match(coq-core)) & installed
# No matches found
`;

describe("rocqPresentIn", () => {
    it("finds a package in opam's installed listing", () => {
        expect(rocqPresentIn(WITH_ROCQ)).toBe(true);
    });

    it("is not fooled by the comment line opam prints when nothing matched", () => {
        // "# No matches found" is a line like any other unless comments are
        // skipped, which is the whole reason this needs parsing at all.
        expect(rocqPresentIn(WITHOUT_ROCQ)).toBe(false);
    });
});

describe("parseSwitchName", () => {
    it("takes the switch name off opam switch show", () => {
        expect(parseSwitchName("vsrocq-dev\n")).toBe("vsrocq-dev");
    });

    it("reports no switch rather than an empty name", () => {
        expect(parseSwitchName("\n")).toBe(null);
    });
});

describe("parseSwitchList", () => {
    it("reads one switch per line from opam switch list --short", () => {
        expect(parseSwitchList("5.4.0\ndefault\nvsrocq-dev\n")).toEqual([
            "5.4.0",
            "default",
            "vsrocq-dev",
        ]);
    });

    it("drops blank lines rather than offering an empty switch", () => {
        expect(parseSwitchList("default\n\n")).toEqual(["default"]);
    });
});

describe("parseInstalledVersion", () => {
    it("reads the version out of opam's name,version listing", () => {
        expect(parseInstalledVersion("vsrocq-language-server 2.4.3\n")).toBe(
            "2.4.3",
        );
    });

    it("keeps opam's revision suffix rather than truncating it", () => {
        // 2.4.3+1 is a real published revision. Dropping the suffix would
        // report a version that does not exist.
        expect(parseInstalledVersion("vsrocq-language-server 2.4.3+1\n")).toBe(
            "2.4.3+1",
        );
    });

    it("reports nothing when opam listed nothing", () => {
        // opam exits 0 with empty output when the package is not installed.
        expect(parseInstalledVersion("")).toBe(null);
    });
});

describe("switchRefForPrefix", () => {
    it("names a switch that lives directly under the opam root", () => {
        expect(
            switchRefForPrefix("/home/t/.opam/rocq-9.2", "/home/t/.opam"),
        ).toEqual({ kind: "global", name: "rocq-9.2" });
    });

    it("addresses a local switch as the directory holding its _opam", () => {
        // That is what --switch takes. Handed the _opam itself, opam looks for
        // a switch inside it and reports none installed.
        expect(
            switchRefForPrefix("/home/t/proj/_opam", "/home/t/.opam"),
        ).toEqual({ kind: "local", prefix: "/home/t/proj" });
    });

    it("does not mistake a nested directory for a switch name", () => {
        expect(
            switchRefForPrefix(
                "/home/t/.opam/download-cache/x",
                "/home/t/.opam",
            ),
        ).toEqual({
            kind: "local",
            prefix: "/home/t/.opam/download-cache/x",
        });
    });

    it("leaves a prefix that is not an _opam alone", () => {
        // Only the _opam convention identifies the parent as the switch.
        expect(switchRefForPrefix("/opt/rocq", "/home/t/.opam")).toEqual({
            kind: "local",
            prefix: "/opt/rocq",
        });
    });

    it("is not thrown by a trailing slash on the root", () => {
        expect(
            switchRefForPrefix("/home/t/.opam/rocq-9.2", "/home/t/.opam/"),
        ).toEqual({ kind: "global", name: "rocq-9.2" });
    });
});

describe("switchPrefixOnPath", () => {
    const BINS = ["/home/t/.opam/rocq-9.2/bin", "/home/t/.opam/vsrocq-819/bin"];

    it("takes the prefix opam env left behind when its bin is on PATH", () => {
        expect(
            switchPrefixOnPath(
                "/home/t/.opam/vsrocq-819/bin:/usr/bin",
                ":",
                "/home/t/.opam/vsrocq-819",
                BINS,
            ),
        ).toBe("/home/t/.opam/vsrocq-819");
    });

    it("ignores a prefix whose bin directory is not on PATH", () => {
        // OPAM_SWITCH_PREFIX and PATH are written together but survive
        // separately, and only PATH decides what `which` resolves. A prefix
        // that PATH does not back names a switch this window is not using.
        expect(
            switchPrefixOnPath(
                "/usr/bin:/bin",
                ":",
                "/home/t/.opam/vsrocq-819",
                BINS,
            ),
        ).toBe(null);
    });

    it("falls back to the first switch bin directory on PATH", () => {
        // A window that inherited a PATH without the rest of the opam
        // environment still resolves binaries through whichever switch bin
        // directory comes first.
        expect(
            switchPrefixOnPath(
                "/usr/bin:/home/t/.opam/rocq-9.2/bin:/home/t/.opam/vsrocq-819/bin",
                ":",
                undefined,
                BINS,
            ),
        ).toBe("/home/t/.opam/rocq-9.2");
    });

    it("reports no switch rather than guessing at an unregistered one", () => {
        // PATH goes through a local switch opam has not registered, so it is
        // not among the bin directories to match. Naming it wrongly would be
        // worse than saying nothing.
        expect(
            switchPrefixOnPath(
                "/home/t/proj/_opam/bin:/usr/bin",
                ":",
                undefined,
                BINS,
            ),
        ).toBe(null);
    });
});
