# VsRocq Language Server

VsRocq is a single OCaml process (`vsrocqtop`) that speaks LSP over stdin/stdout to give VS Code (and VSCodium) interactive checking of Rocq proof scripts. Internally it's a set of cooperating managers driven by a priority event loop, with optional worker processes for parallel proof checking.

## Language

### Document model

**Document**:
The passive data container for one open file: raw text, the ordered list of parsed **Sentences**, and per-sentence **Scheduler** state. It holds no logic — `CheckingManager` and `ExecutionManager` act on it.
_Avoid_: file, buffer

**Sentence**:
A single, complete Vernac command as delimited by Rocq's own parser, ending at the `.` terminator (e.g. `Theorem foo : T.`, `Proof.`, `apply tac.`, `Qed.`). The atomic unit of parsing, caching, and invalidation — there is no sub-sentence granularity.
_Avoid_: statement, command, line

**Scheduler**:
Computes the dependency graph over sentences — which must execute before which, and which can run in parallel — incrementally, so an edit doesn't force recomputing the whole graph.
_Avoid_: task graph, dependency manager

**Vernacstate**:
A snapshot of Rocq's entire global state (defined names, open modules, proof obligations, kernel tables) at one point in the document. Executing a sentence means applying it to a prior `Vernacstate` to produce the next one. `ExecutionManager` caches one snapshot per checked sentence.
_Avoid_: context, environment, kernel state

**Synterp** (syntactic interpretation):
The phase, run during parsing, that resolves `Require`, `Load`, and module opens — anything affecting what names are in scope. Produces `Vernacstate.Synterp.t`, stored per sentence. Strictly sequential: each sentence's synterp state depends on the previous one.
_Avoid_: parsing (see Flagged ambiguities)

**Interp** (semantic elaboration):
The phase that actually type-checks and elaborates a sentence against a `Vernacstate`, run either locally or in a delegated worker. Produces the next `Vernacstate`.
_Avoid_: execution (used loosely elsewhere for the same thing — acceptable, but "interp" is the precise term in code)

**observe_id**:
The sentence up to which the server is currently committed to checking. Set explicitly by the user in manual mode (step forward/backward/to position); always the last sentence of the document in continuous mode.
_Avoid_: cursor position, checkpoint

### Components

**LspManager**:
Dispatches incoming JSON-RPC (LSP requests/notifications) and holds the `states` table mapping document URIs to `{ st: DocumentManager.state; visible }`. A relay, not a barrier — it forwards `DocumentManager` events back into SEL rather than driving logic itself.
_Avoid_: server, dispatcher

**DocumentManager**:
The thin facade `LspManager` calls into; groups `Document`, `CheckingManager`, and `ExecutionManager` behind one API (`interpret_to_position`, `apply_text_edits`, etc.). The real logic lives in the three components it wraps, not in `DocumentManager` itself.
_Avoid_: document handler

**CheckingManager**:
Owns navigation and `observe_id`; validates the document after a parse and asks `ExecutionManager` to invalidate the sentences that changed.
_Avoid_: validator

**ExecutionManager**:
Holds the `Vernacstate` cache keyed by sentence, runs local execution (`Vernacinterp.interp`) for most sentences, and hands `OpaqueProof` tasks to `DelegationManager` when worker delegation is enabled.
_Avoid_: executor, runner

**DelegationManager**:
Spawns and manages the worker process pool (fork on Unix, spawn+marshal on Windows) that checks complete proof blocks off the main thread.
_Avoid_: worker pool (that's what it manages, not what it is)

**OpaqueProof task**:
A complete proof block (`Theorem ... Proof. ... Qed.`) eligible to be checked in a worker process instead of the main `vsrocqtop` thread. The unit `DelegationManager` operates on.
_Avoid_: proof, worker job

**SEL** (Selective Event Loop):
The priority-queue event loop library that drives the whole server. Every parse step, execution step, and incoming LSP message is one SEL event; lower-priority-number events always preempt higher-priority-number ones between steps. Chosen over Lwt/Async specifically so LSP messages can interrupt an in-progress proof check.
_Avoid_: event loop (ambiguous with the generic concept), scheduler (that name is taken by the sentence dependency component above)

### Checking modes

**Continuous mode**:
The server auto-executes sentences up to the end of the document as they're typed, without the user stepping manually.
_Avoid_: auto mode

**Manual mode**:
The user drives `observe_id` explicitly via step forward/backward or interpret-to-point; nothing executes unless requested.
_Avoid_: step mode

## Relationships

- A **Document** contains an ordered list of **Sentences**; each **Sentence** stores the **Scheduler** state before and after it.
- The **Scheduler** computes dependencies between **Sentences**; **ExecutionManager** uses that schedule to decide execution order and what to invalidate.
- **DocumentManager** wraps **Document**, **CheckingManager**, and **ExecutionManager** as a single API for **LspManager**.
- **CheckingManager** owns **observe_id** and tells **ExecutionManager** which sentences to invalidate after a re-parse.
- **ExecutionManager** caches one **Vernacstate** per checked **Sentence**, and hands **OpaqueProof tasks** to **DelegationManager** when worker delegation is on.
- **DelegationManager** spawns worker processes that run **Interp** for delegated **OpaqueProof tasks**; results return to **SEL** as regular (lower-priority) events.
- **SEL** sequences every step of this pipeline — parsing, **Synterp**, **Interp**, LSP messages — as prioritized events, which is what lets an incoming edit preempt an in-flight proof check.

## Example dialogue

> **Dev:** "When the user edits a sentence mid-file, do we recheck the whole document?"
> **Domain expert:** "No — only that **Sentence** and whatever the **Scheduler** says depends on it. Everything before is reused: `ExecutionManager` still has its **Vernacstate** snapshots cached."
>
> **Dev:** "And if a `didChange` arrives while a proof is still executing in a worker?"
> **Domain expert:** "**SEL** lets the `didChange` preempt it — that's priority -6 versus -2. The document gets reparsed, `CheckingManager` invalidates the affected sentences, and execution resumes from the last valid `observe_id`. Whatever the worker was mid-computing for the old text gets discarded."
>
> **Dev:** "Is `DocumentManager` where the invalidation logic actually lives?"
> **Domain expert:** "No, `DocumentManager` is just the facade. `CheckingManager` decides what's invalid; `ExecutionManager` clears the cached `Vernacstate`s."

## Flagged ambiguities

- "Parsing" is often used loosely to cover both the syntactic parse step and **Synterp**, but they're distinct: synterp runs *during* the parse step and produces its own sequential state (`Vernacstate.Synterp.t`), separate from the parsed AST. When precision matters (e.g. discussing incrementality), say "parse" for the AST and "synterp" for the scope-resolution side effect.
- "Scheduler" collides with the general concept of a task scheduler — in this codebase it refers specifically to the sentence-dependency component in `dm/scheduler.ml`, not to SEL (which is the actual event loop / dispatcher).
- "Execution" is used both narrowly (the **Interp** phase, i.e. `Vernacinterp.interp`) and broadly (the whole check pipeline including parsing). Prefer **Interp** when talking about the elaboration step specifically.
