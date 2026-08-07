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

open Types

val mk_log : string -> (?force:bool -> (unit -> string) -> unit) log
val logs : unit -> string list

val is_debug_enabled : string -> bool
(** [is_debug_enabled name] tells whether [name] was selected by -vsrocq-d or
    by VSROCQ_ARGS, using the same matching as [mk_log]. For debugging work
    that is more than printing a message -- a check too expensive to leave on
    -- and so needs the flag as a plain boolean. *)

type event = string
type events = event Sel.Event.t list

val lsp_initialization_done : unit -> events
val handle_event : event -> unit

val worker_initialization_begins : unit -> unit
val worker_initialization_done : fwd_event:(event -> unit) -> unit

(* debug messages coming from either the language server of Rocq *)
val debug : event Sel.Event.t

[%% if rocq = "8.18" || rocq = "8.19" || rocq = "8.20" ]
val feedback_add_feeder_on_Message : (Feedback.route_id -> Stateid.t -> Feedback.doc_id -> Feedback.level -> Loc.t option -> 'a list -> Pp.t -> unit) -> int
[%%else]
val feedback_add_feeder_on_Message : (Feedback.route_id -> Stateid.t  -> Feedback.doc_id -> Feedback.level -> Loc.t option -> Quickfix.t list -> Pp.t -> unit) -> int
[%%endif]
