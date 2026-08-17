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

[%%import "vsrocq_config.mlh"]

open Types

let preempt = ref false
let set_options ~preempt:x = preempt := x

let (Log log) = Log.mk_log "proverThread"

type retry = bool
module Queue = struct
  type 'a t = 'a list ref

  let create () = ref []
  let is_empty q = [] = !q
  let pop q =
    match !q with
    | [] -> assert false
    | x :: xs -> q := xs; x
  let enqueue x q = q := !q @ [x]
  let add_head x q = q := x :: !q
  let iter f q = List.iter f !q

end

(* We run Rocq in a thread so that we can interrupt it *)
type rocq_job =
  | Job :
      document_id
      * string
      * (Memprof_limits.Token.t -> 'a interruptible_result)
      * 'a interruptible_result Sel.Promise.handler
      * Memprof_limits.Token.t
      * retry ref
      -> rocq_job

type jobs = { mutable running : rocq_job option; queue : rocq_job Queue.t }

let jobs : jobs = { running = None; queue = Queue.create () }

let jobs_mutex = Mutex.create ()
let jobs_condition = Condition.create ()

(* Rocq's pretyper recurses once per level of nesting in the term it
   elaborates, so the stack this thread gets bounds how deep a term the server
   can check. Thread.create leaves that size to the platform: Linux hands out
   8 MB, the same as the main thread, but macOS hands out 512 KB, and there
   the budget runs out at roughly 950 levels -- [Definition x : nat := 1000.]
   is already past it, since the numeral elaborates to 1000 nested [S]. The
   overflow is not survivable either: OCaml installs its stack-overflow
   handler for SIGSEGV, but macOS reports a secondary thread hitting its guard
   page as SIGBUS, so the whole server dies with no diagnostic and no log
   entry. Ask for the 8 MB the main thread gets, which is what the platforms
   without this problem already hand out, and which puts the ceiling exactly
   where `rocq compile` has it: both give up between 2000 and 3000 levels,
   measured. Past that the file does not compile either, so there is little to
   gain from going higher. *)
let stack_size_mb = 8

external create_with_stack : int -> (unit -> unit) -> bool
  = "vsrocq_thread_create_with_stack"

(* Makes an overflow on this thread a sentence error instead of a signal that
   kills the server -- on macOS, where the runtime is not installed on the
   signal the platform delivers. Only half the story there; the other half is
   in the trampoline.

   On Linux the runtime is already installed on the right signal and this
   changes nothing about which overflows survive. What it adds is a name for
   the one kind that cannot: an overflow that reaches the guard page from
   inside the runtime's own C is declined, and until this the process simply
   vanished with a bare SIGSEGV and nothing on stderr to tell it from any
   other crash. See proverThreadStubs.c for all of it. *)
external report_thread_stack_overflow : unit -> unit
  = "vsrocq_report_thread_stack_overflow"

let spawn f =
  report_thread_stack_overflow ();
  if not (create_with_stack stack_size_mb f) then
    ignore (Thread.create f () : Thread.t)

let () =
  spawn
    (fun () ->
      while true do
        (* get a job *)
        let Job (doc_id , name, task, resolver, token, retry) =
          Mutex.lock jobs_mutex;
          while Queue.is_empty jobs.queue do
            Condition.wait jobs_condition jobs_mutex
          done;
          let rc = Queue.pop jobs.queue in
          jobs.running <- Some rc;
          Condition.signal jobs_condition;
          Mutex.unlock jobs_mutex;
          rc
        in

        (* run the job *)
        log (fun () -> Printf.sprintf "runner: job begins: %s" name);
        match task token with
        | Interrupted when !retry ->
            Mutex.lock jobs_mutex;
            log (fun () -> Printf.sprintf "runner: postponing running job: %s" name);
            jobs.running <- None;
            Queue.enqueue (Job (doc_id , name, task, resolver, Memprof_limits.Token.create (), ref false)) jobs.queue;
            Condition.signal jobs_condition;
            Mutex.unlock jobs_mutex

        | x ->
            Mutex.lock jobs_mutex;
            log (fun () -> Printf.sprintf "runner: job ends: %s" name);
            Sel.Promise.fulfill resolver x;
            jobs.running <- None;
            Condition.signal jobs_condition;
            Mutex.unlock jobs_mutex

      done)

let interrupt_job_if ~doc_id (Job(id,_,_,_,token,_)) = if id = doc_id then Memprof_limits.Token.set token

let postpone_job (Job(_,name,_,_,token,retry)) =
  if not !preempt then ()
  else begin
    log (fun () -> Printf.sprintf "main: postponing running job: %s" name);
    retry := true;
    Memprof_limits.Token.set token
  end

let interrupt ~doc_id =
  Mutex.lock jobs_mutex;
  Option.iter (interrupt_job_if ~doc_id) jobs.running;
  Queue.iter (interrupt_job_if ~doc_id) jobs.queue;
  Mutex.unlock jobs_mutex

let limit f token =
  match Terminated (Memprof_limits.limit_with_token ~token f) with
  | Aborted _ | Interrupted -> assert false
  | Terminated (Error _) -> Interrupted
  | Terminated (Ok x) -> Terminated x
  | exception e ->
      let e, info = Exninfo.capture e in
      Aborted (CErrors.iprint (e, info))

let busy_wait timeout p token =
  let timeout = Unix.gettimeofday () +. timeout in
  while not (Sel.Promise.is_resolved p) && Unix.gettimeofday () < timeout do
    Unix.sleepf 0.01;
  done;
  Memprof_limits.Token.set token;
  try
    match Sel.Promise.get p with
    | Sel.Promise.Fulfilled x -> x
    | Sel.Promise.Rejected e -> raise e (* bug *)
  with Failure _ -> Aborted (Pp.str "Rocq times out")


let try_run ~doc_id ~name ~timeout f =
  log (fun () -> "main: run");
  let token = Memprof_limits.Token.create () in
  let promise, r = Sel.Promise.make () in
  Mutex.lock jobs_mutex;
  Option.iter postpone_job jobs.running;
  Queue.add_head (Job (doc_id, name, limit f, r, token, ref false)) jobs.queue;
  Condition.signal jobs_condition;
  Mutex.unlock jobs_mutex;
  busy_wait timeout promise token

let eventually_run ~doc_id ~name f =
  log (fun () -> "main: eventually_run");
  let token = Memprof_limits.Token.create () in
  let promise, r = Sel.Promise.make () in
  Mutex.lock jobs_mutex;
  Queue.enqueue (Job (doc_id, name, limit f, r, token, ref false)) jobs.queue;
  Condition.signal jobs_condition;
  Mutex.unlock jobs_mutex;
  promise

let run ~doc_id ~name f =
  log (fun () -> "main: run");
  let token = Memprof_limits.Token.create () in
  let promise, r = Sel.Promise.make () in
  Mutex.lock jobs_mutex;
  Option.iter postpone_job jobs.running;
  Queue.add_head (Job (doc_id, name, limit f, r, token, ref false)) jobs.queue;
  Condition.signal jobs_condition;
  Mutex.unlock jobs_mutex;
  match busy_wait 99999. promise token with
  | Interrupted -> assert false
  | Aborted pp -> Result.Error pp
  | Terminated x -> Result.Ok x



