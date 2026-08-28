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
    // out/test: sibling directories hold suites that run outside VS Code and
    // are written in BDD (`describe`/`it`). Loading one of those under this
    // TDD UI throws `describe is not defined` at module scope, before any
    // test runs, which kills the whole Electron run.
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
