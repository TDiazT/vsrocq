import { expect } from "expect";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    missingConfiguredServerMessage,
    resolveServerBinary,
} from "../../utilities/serverBinary";

describe("resolveServerBinary", () => {
    let dir: string;
    let binary: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "vsrocq-bin-"));
        binary = join(dir, "vsrocqtop");
        writeFileSync(binary, "#!/bin/sh\n");
        chmodSync(binary, 0o755);
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("accepts an absolute path to an executable", async () => {
        expect(await resolveServerBinary(binary, "")).toBe(binary);
    });

    it("rejects an absolute path with nothing behind it", async () => {
        // The fix relies on `which` testing a value with a separator as a
        // file rather than searching PATH for it; pin that here.
        expect(await resolveServerBinary(join(dir, "missing"), "")).toBe(null);
    });

    it("finds a bare name through the given PATH", async () => {
        expect(await resolveServerBinary("vsrocqtop", dir)).toBe(binary);
    });

    it("rejects a bare name that the given PATH does not hold", async () => {
        expect(await resolveServerBinary("vsrocqtop", "/nonexistent")).toBe(
            null,
        );
    });
});

describe("missingConfiguredServerMessage", () => {
    it("names the setting and the path when a path was given", () => {
        expect(missingConfiguredServerMessage("/opt/x/vsrocqtop")).toContain(
            "vsrocq.path is set to /opt/x/vsrocqtop, but there is no executable there",
        );
    });

    it("says PATH when a bare name was given", () => {
        expect(missingConfiguredServerMessage("vsrocqtop")).toContain(
            "not on this window's PATH",
        );
    });
});
