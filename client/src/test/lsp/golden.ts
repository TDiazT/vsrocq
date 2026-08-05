import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `.json` fixtures live under source control (`client/src/test/lsp/golden/`),
 * not under `out/`: `tsc` does not copy non-`.ts` files, and these are read
 * and written at test-run time by path, not by `import`.
 */
const goldenDir = path.resolve(__dirname, "../../../src/test/lsp/golden");

/**
 * Compares `actual` against the golden file `<name>.json`, deep-equal on the
 * parsed JSON (so key order in the file doesn't matter).
 *
 * With `UPDATE_GOLDEN=1`, writes `actual` as the new golden instead of
 * comparing, and never fails. This is a working-tree write, not a commit.
 * Per `docs/adr/0001-protocol-level-test-safety-net.md`, a regeneration is
 * reviewed as a diff before it is committed. Before accepting one, check
 * that the change is the one you expected from whatever prompted the
 * regeneration (a Rocq upgrade, a deliberate protocol change) and not a
 * regression the test just froze in place.
 */
export function expectGolden(name: string, actual: unknown): void {
    const file = path.join(goldenDir, `${name}.json`);
    const serialized = JSON.stringify(actual, null, 2) + "\n";

    if (process.env.UPDATE_GOLDEN === "1") {
        fs.mkdirSync(goldenDir, { recursive: true });
        fs.writeFileSync(file, serialized);
        return;
    }

    let expected: string;
    try {
        expected = fs.readFileSync(file, "utf-8");
    } catch {
        throw new Error(
            `No golden file at ${file}. Run with UPDATE_GOLDEN=1 to create it, ` +
                `then read the diff before committing what it wrote.`,
        );
    }

    assert.deepStrictEqual(
        JSON.parse(serialized),
        JSON.parse(expected),
        `${name} does not match ${file}. If this is expected, rerun with ` +
            `UPDATE_GOLDEN=1 and read the diff before committing it.`,
    );
}
