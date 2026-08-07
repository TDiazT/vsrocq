(* A `nat` literal elaborates to that many nested `S`, and Rocq's pretyper
   recurses once per level, so this one sentence asks the prover thread for
   about two thousand stack frames. See deepTerm.test.ts. *)
Definition deep : nat := 2000.
