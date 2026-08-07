(* A tactic that recurses without making progress. It runs the prover thread
   out of stack whatever size that stack is, so the sentences after it are
   there to show that checking carries on regardless. See
   stackOverflow.test.ts. *)
Goal True.
Proof.
  (let rec loop := loop in loop).
Qed.

Definition after_the_overflow : nat := 4.
Definition uses_it : nat := after_the_overflow.
