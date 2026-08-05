import { glob } from "glob";
import Mocha from "mocha";
import * as path from "path";

export async function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: "tdd",
        color: true,
    });

    const testsRoot = path.resolve(__dirname, "..");

    // Name the Electron suite rather than sweeping everything under
    // out/test: the sibling lsp/ directory holds the stdio LSP suite, which
    // is written in BDD (`describe`/`it`) and runs outside VS Code via
    // `npm run test:lsp`. Loading one of its files under this TDD UI throws
    // `describe is not defined` at module scope, before any test runs.
    const files = await glob("suite/**/*.test.js", { cwd: testsRoot });

    // Add files to the test suite
    files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

    return new Promise((resolve, reject) => {
        // Run the mocha test
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} tests failed.`));
            } else {
                resolve();
            }
        });
    });
}
