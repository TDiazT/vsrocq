(* Fixture for the edit-cycle tests in didChange.test.ts.

   Those tests edit the tail of this file: they append after the last
   definition, and replace what they appended. Two properties matter and
   neither is incidental.

   Nothing below depends on anything above it. A type error introduced in one
   of these definitions therefore yields exactly one diagnostic, which is what
   makes "the error appeared" and "the error is gone" assertable by count. An
   error in a name that a later sentence uses cascades instead: measured on an
   8-line fixture, breaking the first definition produced six diagnostics, five
   of them consequences ("The reference one was not found", "No proof-editing
   in progress").

   There is no proof here, only definitions. A `Proof.`/`Qed.` block turns any
   error above it into three more diagnostics of the second kind.

   Only the prelude is used: the switch this suite is developed against has no
   rocq-stdlib, so `Reals`, `ZArith`, `List` and `PeanoNat` are all
   unavailable. *)

Definition one : nat := 1.

Definition two : nat := 2.

Definition three : nat := 3.
