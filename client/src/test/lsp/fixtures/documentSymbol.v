Section Basics.

  Definition one := 1.

  Inductive bin :=
  | O
  | I.

  Lemma one_eq_one : one = 1.
  Proof.
    reflexivity.
  Qed.

End Basics.

Definition two := 1 + 1.
