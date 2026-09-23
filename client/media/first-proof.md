# Step through a proof

Open a `.v` file, or create one with:

```
Lemma and_swap (A B : Prop) : A /\ B -> B /\ A.
Proof.
  intros [a b]. split.
  - exact b.
  - exact a.
Qed.
```

| Action | Windows and Linux | macOS |
|---|---|---|
| Step forward | Alt+Down | Ctrl+Alt+Down |
| Step back | Alt+Up | Ctrl+Alt+Up |
| Check up to the cursor | Alt+Right | Ctrl+Alt+Right |
| Check the whole file | Alt+End | Ctrl+Alt+End |

The goals appear in the proof view next to the editor.

By default you step through the file yourself. To have the extension check the file as you type, set `vsrocq.proof.mode` to `Continuous`.

If the proof view stays empty, go to the next step.
