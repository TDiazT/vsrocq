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
    arbitrary Vernacstate.t, independent of any open document past [start].
    See CONTEXT.md "Petanque-lite" and
    audit/Reevaluación de Base — VsRocq vs RocqLSP (2026-07).md §6, Fase 0. *)

open Types
open Protocol

module HandleTable = struct
  let table : (int, Vernacstate.t) Hashtbl.t = Hashtbl.create 39
  let next = ref 0

  let alloc (st : Vernacstate.t) : int =
    incr next;
    Hashtbl.replace table !next st;
    !next

  let find (h : int) : Vernacstate.t option =
    Hashtbl.find_opt table h
end

(* Not tied to any open document's real feedback_pipe: Rocq feedback emitted
   during [run] (e.g. from [idtac]) is routed here and simply never
   collected. Out of scope for the spike (see CONTEXT.md). *)
let doc_id : document_id = -1

let start (document : Document.document) (pos : Lsp.Types.Position.t) : (int, string) result =
  match Document.find_sentence_before_pos document pos with
  | None -> Error "No sentence found at or before that position"
  | Some { id; _ } ->
    match CheckingManager.vernac_state_of_sentence document id with
    | None -> Error "Sentence not yet checked - interpret the document up to this point first"
    | Some st -> Ok (HandleTable.alloc st)

let parse_and_synterp (st : Vernacstate.t) (text : string)
  : (Synterp.vernac_control_entry * Vernacstate.Synterp.t, string) result =
  try
    Vernacstate.Synterp.unfreeze st.Vernacstate.synterp;
    CLexer.record_comments := true;
    let entry = Pvernac.main_entry (Some (Synterp.get_default_proof_mode ())) in
    let stream = Gramlib.Stream.of_string text in
    let pa = Procq.Parsable.make stream in
    match Procq.Entry.parse entry pa with
    | None -> Error "Empty input"
    | Some raw_ast ->
      let intern = Vernacinterp.fs_intern in
      let synterp_entry = Synterp.synterp_control ~intern raw_ast in
      let synterp_state = Vernacstate.Synterp.freeze () in
      Ok (synterp_entry, synterp_state)
  with e ->
    let e, info = Exninfo.capture e in
    Error (Pp.string_of_ppcmds @@ CErrors.iprint_no_report (e, info))

let run (h : int) (tactic : string) : (int, string) result =
  match HandleTable.find h with
  | None -> Error (Printf.sprintf "Unknown state handle %d" h)
  | Some st ->
    match parse_and_synterp st tactic with
    | Error msg -> Error msg
    | Ok (ast, synterp) ->
      let st = { st with Vernacstate.synterp } in
      let state_id = Stateid.fresh () in
      match
        ProverThread.run ~doc_id ~name:"petanque_lite_run" (fun () ->
          ExecutionManager.interp_ast ~doc_id ~state_id ~st ~error_recovery:Scheduler.RSkip ast)
      with
      | Error pp -> Error (Pp.string_of_ppcmds pp)
      | Ok (_, Success (Some new_st)) -> Ok (HandleTable.alloc new_st)
      | Ok (_, Success None) -> Error "Tactic produced no resulting state"
      | Ok (_, Failure ((_loc, msg), _, _)) -> Error (Pp.string_of_ppcmds msg)

let goals (h : int) : (PpProofState.t option, string) result =
  match HandleTable.find h with
  | None -> Error (Printf.sprintf "Unknown state handle %d" h)
  | Some st -> Ok (PpProofState.get_proof st)
