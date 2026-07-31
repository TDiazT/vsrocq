(**************************************************************************)
(*                                                                        *)
(*                                 VSRocq                                 *)
(*                                                                        *)
(*                   Copyright INRIA and contributors                     *)
(*       (see version control and README file for authors & dates)        *)
(*                                                                        *)
(**************************************************************************)
(*                                                                        *)
(*   This file is distributed under the terms of the MIT License.         *)
(*   See LICENSE file.                                                    *)
(*                                                                        *)
(**************************************************************************)

(** Petanque-lite (spike, 2026-07): a minimal start/run/goals surface over an
    arbitrary Vernacstate.t, keyed by integer handles so the MCP wire never
    serializes a full Vernacstate.t. See CONTEXT.md "Petanque-lite" /
    "State handle". *)

(** [start document pos] finds the sentence at or before [pos] in [document]
    and returns a handle to its already-checked Vernacstate.t.
    Errors if there is no such sentence, or if it hasn't been checked yet
    (the client must interpret the document up to [pos] first, e.g. via
    interpret_to_point/interpret_to_end). *)
val start : Document.document -> Lsp.Types.Position.t -> (int, string) result

(** [run handle tactic] parses [tactic] against the state referenced by
    [handle] and interprets it. On success, returns a handle to the
    resulting state. On failure, [handle] is left untouched and no new
    handle is allocated. *)
val run : int -> string -> (int, string) result

(** [goals handle] returns the pretty-printed goals/hypotheses for the state
    referenced by [handle], or [None] if no proof is open. *)
val goals : int -> (Protocol.PpProofState.t option, string) result
