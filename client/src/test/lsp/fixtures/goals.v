Lemma plus_n_O : forall n : nat, n + 0 = n.
Proof.
  intros n.
  induction n as [| n IH].
  - reflexivity.
  - simpl. rewrite IH. reflexivity.
Qed.
