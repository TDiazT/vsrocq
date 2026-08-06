(* Fixture for interpretToEnd.test.ts. Nothing here is interesting to check;
   what matters is that the file takes more than zero parse events to get
   through, so that a `prover/interpretToEnd` sent right after `didOpen`
   lands while the document is still being parsed. *)

Definition zero : nat := 0.

Lemma zero_eq_zero : zero = 0.
Proof.
  reflexivity.
Qed.

Definition one : nat := S zero.

Lemma one_eq_one : one = 1.
Proof.
  reflexivity.
Qed.

Definition two : nat := S one.
