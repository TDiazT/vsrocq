open Common
open Dm
open Types
open Base

[@@@warning "-27"]

let validate_document parsed_document =
  let doc, events = Document.validate_document parsed_document in
  let todo = Sel.Todo.add Sel.Todo.empty events in
  handle_d_events todo doc

let trdeps doc s1 =
  (* This closure should be an API used in Schedule used by ExecutionManager *)
  let rec trclose f s =
    let s' = Stateid.Set.fold (fun x acc -> Stateid.Set.union (f x) acc) s s in
    if Stateid.Set.equal s s' then s
    else trclose f s' in
  trclose (Scheduler.dependents (Document.schedule doc)) (Stateid.Set.singleton s1.id)


let%test_unit "parse.validate_errors_twice" = 
  let Document.{parsed_document} = init_and_parse_test_doc () ~text:"Lemma a : True. Proof. idtac (fun x -> x). Qed." in
  let Document.{unchanged_id; invalid_ids; parsed_document} = validate_document parsed_document in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid_ids);
  let s1,(s2,(s3,(s4,()))) = d_sentences parsed_document (P(P(E(P(O))))) in
  [%test_eq: sentence_id option] (Some s4.id) unchanged_id;
  let Document.{parsed_document} = validate_document parsed_document in
  [%test_eq: int] (List.length (Document.parse_errors parsed_document)) 1;
  let Document.{parsed_document}= validate_document parsed_document in
  [%test_eq: int] (List.length (Document.parse_errors parsed_document)) 1

let %test_unit "document: invalidate top" =
  let Document.{parsed_document} = init_and_parse_test_doc () ~text:"Definition x := 3. Lemma foo : x = 3. Proof. reflexivity. Qed." in
  let Document.{unchanged_id; invalid_ids; parsed_document} = validate_document parsed_document in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid_ids);
  let s1,(s2,(s3,(s4,(s5,())))) = d_sentences parsed_document (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id option] (Some s5.id) unchanged_id;
  let parsed_document = Document.apply_text_edits parsed_document [Document.range_of_id parsed_document s1.id,"Definition x := 4."] in
  let Document.{unchanged_id; invalid_ids; parsed_document} = validate_document parsed_document in
  let r1,(r2,(r3,(r4,(r5,())))) = d_sentences parsed_document (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id list] [s1.id] (Stateid.Set.elements invalid_ids);
  [%test_eq: sentence_id option] None unchanged_id;
  [%test_eq: sentence_id] s2.id r2.id;
  [%test_eq: sentence_id] s3.id r3.id;
  [%test_eq: sentence_id] s4.id r4.id;
  [%test_eq: sentence_id] s5.id r5.id;
  let deps = trdeps parsed_document s1 in
  [%test_pred: sentence_id] (fun x -> Stateid.Set.mem x deps) r2.id;
  [%test_pred: sentence_id] (fun x -> Stateid.Set.mem x deps) r3.id;
  [%test_pred: sentence_id] (fun x -> Stateid.Set.mem x deps) r4.id;
  [%test_pred: sentence_id] (fun x -> Stateid.Set.mem x deps) r5.id;
  ()

let %test_unit "document: invalidate proof" =
  let Document.{parsed_document} = init_and_parse_test_doc () ~text:"Definition x := 3. Lemma foo : x = 3. Proof. reflexivity. Qed." in
  let Document.{unchanged_id; invalid_ids; parsed_document} = validate_document parsed_document in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid_ids);
  let s1,(s2,(s3,(s4,(s5,())))) = d_sentences parsed_document (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id option] (Some s5.id) unchanged_id;
  let parsed_document = Document.apply_text_edits parsed_document [Document.range_of_id parsed_document s3.id,"idtac."] in
  let Document.{unchanged_id; invalid_ids; parsed_document} = validate_document parsed_document in
  let r1,(r2,(r3,(r4,(r5,())))) = d_sentences parsed_document (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id list] [s3.id] (Stateid.Set.elements invalid_ids);
  [%test_eq: sentence_id option] (Some s2.id) unchanged_id;
  [%test_eq: sentence_id] s1.id r1.id;
  [%test_eq: sentence_id] s2.id r2.id;
  [%test_eq: sentence_id] s4.id r4.id;
  [%test_eq: sentence_id] s5.id r5.id;
  let deps = trdeps parsed_document s3 in
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x deps)) r1.id;
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x deps)) r2.id;
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x deps)) r3.id;
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x deps)) r5.id;
  ()


let %test_unit "document: invalidate proof 2" =
  let Document.{parsed_document} = init_and_parse_test_doc () ~text:"Definition x := 3. Lemma foo : x = 3. Proof. reflexivity. Qed." in
  let Document.{unchanged_id; invalid_ids; parsed_document} = validate_document parsed_document in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid_ids);
  let s1,(s2,(s3,(s4,(s5,())))) = d_sentences parsed_document (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id option] (Some s5.id) unchanged_id;
  let parsed_document = Document.apply_text_edits parsed_document [Document.range_of_id parsed_document s3.id,""] in
  let Document.{unchanged_id; invalid_ids; parsed_document} = validate_document parsed_document in
  let r1,(r2,(r3,(r4,()))) = d_sentences parsed_document (P(P(P(P(O))))) in
  [%test_eq: sentence_id list] [s3.id;s4.id;s5.id] (Stateid.Set.elements invalid_ids);
  [%test_eq: sentence_id option] (Some s2.id) unchanged_id;
  [%test_eq: sentence_id] s1.id r1.id;
  [%test_eq: sentence_id] s2.id r2.id

let %test_unit "document: delete line" = 
  let Document.{unchanged_id; invalid_ids; parsed_document} = init_and_parse_test_doc () ~text:"Definition x:= 3. Lemma foo : x = 3. Proof. reflexitivity. Qed." in 
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid_ids);
  let s1,(s2,(s3,(s4,(s5,())))) = d_sentences parsed_document (P(P(P(P(P(O)))))) in
  let parsed_document = Document.apply_text_edits parsed_document [Document.range_of_id parsed_document s5.id,""] in
  let Document.{unchanged_id; invalid_ids; parsed_document} = validate_document parsed_document in 
  let sentences_id = Stateid.Set.of_list (List.map (Document.sentences parsed_document) ~f:(fun s -> s.id)) in
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x sentences_id)) s5.id;
  ()

let %test_unit "document: expand sentence" =
  let Document.{unchanged_id; invalid_ids; parsed_document} = init_and_parse_test_doc () ~text:"Lemma foo : x = 3. M." in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid_ids);
  let s1,(s2,()) = d_sentences parsed_document (P(P(O))) in
  let range = Document.range_of_id parsed_document s2.id in
  let new_range = Lsp.Types.Range.{ start = range.end_; end_ = range.end_ } in
  let parsed_document = Document.apply_text_edits parsed_document [new_range,"foo."] in
  let Document.{unchanged_id; invalid_ids; parsed_document} = validate_document parsed_document in
  let r1,(r2,()) = d_sentences parsed_document (P(P(O))) in
  [%test_eq: sentence_id] s1.id r1.id;
  ()
(* [Document.diags_version] is what lets lspManager skip a publication that
   would tell the client nothing new; the comment on the field in document.ml
   says why that is worth doing. What follows pins down the transitions it has
   to tell apart.

   As a guard it is weak: it only sees the sequence it drives itself, so a
   mutation added to document.ml later, at a site nobody thought of here, goes
   unnoticed. The check behind `-vsrocq-d diags-version` in lspManager is what
   covers those. *)

let unchanged ~before doc =
  [%test_eq: int] before (Document.diags_version doc);
  doc

let moved ~before doc =
  [%test_pred: int] (fun v -> not (Int.equal before v)) (Document.diags_version doc);
  doc

let %test_unit "document: diags_version moves when a checking error appears or goes away" =
  let Document.{parsed_document} = init_and_parse_test_doc () ~text:"Definition x := 3. Definition y := 4." in
  let s1,(s2,()) = d_sentences parsed_document (P(P(O))) in
  let failed = Failure ((None, Pp.str "boom"), None, None) in
  (* Checking a sentence that turns out fine is what happens to the vast
     majority of them, and publishes nothing. *)
  let before = Document.diags_version parsed_document in
  let doc = unchanged ~before @@ Document.update_checked parsed_document (s2.id, Success None) in
  (* An error appearing, and then going away on a re-check. *)
  let doc = moved ~before @@ Document.update_checked doc (s1.id, failed) in
  let before = Document.diags_version doc in
  let doc = moved ~before @@ Document.update_checked doc (s1.id, Success None) in
  (* Dropping the result of a sentence that had no error retracts nothing. *)
  let before = Document.diags_version doc in
  let doc = unchanged ~before @@ Document.set_unchecked doc s1.id in
  (* Dropping the result of one that had an error does. *)
  let doc = Document.update_checked doc (s1.id, failed) in
  let before = Document.diags_version doc in
  let _ = moved ~before @@ Document.set_unchecked doc s1.id in
  ()

let %test_unit "document: diags_version counts Error and Warning feedback, not Info" =
  let Document.{parsed_document} = init_and_parse_test_doc () ~text:"Definition x := 3." in
  let s1,() = d_sentences parsed_document (P(O)) in
  let message lvl : feedback_message = (lvl, None, [], Pp.str "message") in
  (* Info is the "x is defined" every sentence emits. It is filtered out before
     it reaches the client, so counting it would mark the document as changed
     at every single sentence -- which is the whole thing being avoided. *)
  let before = Document.diags_version parsed_document in
  let doc = unchanged ~before @@ Document.append_feedback parsed_document s1.id (message Feedback.Info) in
  let doc = unchanged ~before @@ Document.append_feedback doc s1.id (message Feedback.Notice) in
  let doc = unchanged ~before @@ Document.append_feedback doc s1.id (message Feedback.Debug) in
  let doc = moved ~before @@ Document.append_feedback doc s1.id (message Feedback.Warning) in
  let before = Document.diags_version doc in
  let _ = moved ~before @@ Document.append_feedback doc s1.id (message Feedback.Error) in
  ()
