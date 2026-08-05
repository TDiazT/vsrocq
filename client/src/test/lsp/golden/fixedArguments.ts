import { useFixedServerArguments } from "../harness";

/**
 * Loaded by `npm run test:lsp:golden` through mocha's `--require`, ahead of
 * every test file in this directory. It carries no tests itself, and its name
 * keeps it out of the spec glob (`golden/*.test.js`), so it is not also
 * collected as one.
 *
 * Being here rather than in each test's own `LspHarness.start()` call is the
 * point of it: a golden is pinned by having been put in this directory, which
 * is already what decides that it runs on the one Rocq 9.2 job. Nothing is
 * left for the next golden's author to remember.
 *
 * `fixedArguments.test.ts` checks that this file is in fact reaching the
 * suite.
 */
useFixedServerArguments();
