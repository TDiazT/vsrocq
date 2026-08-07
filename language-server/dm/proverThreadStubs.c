/**************************************************************************/
/*                                                                        */
/*                                 VSRocq                                 */
/*                                                                        */
/*                   Copyright INRIA and contributors                     */
/*       (see version control and README file for authors & dates)        */
/*                                                                        */
/**************************************************************************/
/*                                                                        */
/*   This file is distributed under the terms of the MIT License.         */
/*   See LICENSE file.                                                    */
/*                                                                        */
/**************************************************************************/

/* Thread.create leaves the stack size up to the platform, and macOS gives a
   secondary thread 512 KB where the main thread gets 8 MB. That is not enough
   for Rocq, whose pretyper recurses once per level of nesting in the term it
   elaborates: see proverThread.ml for the measurements. This creates the
   thread through pthread directly so we can ask for a bigger stack, and hands
   it to the OCaml runtime with the documented registration calls.

   Returns false without doing anything if the platform is not pthread-based
   or the thread could not be created, so the caller can fall back to
   Thread.create. */

#include <caml/mlvalues.h>
#include <caml/memory.h>
#include <caml/callback.h>
#include <caml/threads.h>

#ifndef _WIN32
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>

/* Creating the thread ourselves means doing the setup the runtime would have
   done for us, and one piece of it is easy to miss: an alternate signal stack,
   without which a stack overflow on this thread cannot be reported at all,
   since the handler has no stack left to run on. caml_thread_start installs
   one for every thread the runtime creates (it calls
   caml_setup_stack_overflow_detection), but caml_c_thread_register, the entry
   point for a thread it did not create, does not. Skipping it would trade a
   reportable overflow for a process the kernel kills outright, since it has
   nowhere to push the signal frame: SIGSEGV on Linux, and on macOS a SIGILL,
   which is what the kernel falls back to when delivery itself fails. Measured
   on both, so this is not a macOS workaround.

   This is the same three POSIX calls the runtime makes, spelled out here
   rather than borrowed, because the runtime's version is behind
   CAML_INTERNALS. */
static void *setup_alt_signal_stack(void)
{
  stack_t stk;
  stk.ss_size = SIGSTKSZ;
  stk.ss_sp = malloc(stk.ss_size);
  if (stk.ss_sp == NULL) return NULL;
  stk.ss_flags = 0;
  if (sigaltstack(&stk, NULL) == -1) {
    free(stk.ss_sp);
    return NULL;
  }
  return stk.ss_sp;
}

static void *vsrocq_thread_trampoline(void *arg)
{
  value *closure = (value *) arg;
  caml_c_thread_register();
  caml_acquire_runtime_system();
  setup_alt_signal_stack();
  /* The runner never returns, but a _exn variant keeps an escaping exception
     from unwinding past the OCaml runtime. */
  caml_callback_exn(*closure, Val_unit);
  caml_remove_generational_global_root(closure);
  caml_release_runtime_system();
  caml_c_thread_unregister();
  caml_stat_free(closure);
  return NULL;
}
#endif

CAMLprim value vsrocq_thread_create_with_stack(value stack_mb, value closure)
{
  CAMLparam2(stack_mb, closure);
#ifdef _WIN32
  (void) stack_mb;
  (void) closure;
  CAMLreturn(Val_false);
#else
  pthread_attr_t attr;
  pthread_t thread;
  value *root;

  if (pthread_attr_init(&attr) != 0)
    CAMLreturn(Val_false);
  if (pthread_attr_setstacksize(&attr, ((size_t) Long_val(stack_mb)) << 20) != 0
      || pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED) != 0) {
    pthread_attr_destroy(&attr);
    CAMLreturn(Val_false);
  }

  root = (value *) caml_stat_alloc(sizeof(value));
  *root = closure;
  caml_register_generational_global_root(root);

  if (pthread_create(&thread, &attr, vsrocq_thread_trampoline, root) != 0) {
    caml_remove_generational_global_root(root);
    caml_stat_free(root);
    pthread_attr_destroy(&attr);
    CAMLreturn(Val_false);
  }

  pthread_attr_destroy(&attr);
  CAMLreturn(Val_true);
#endif
}
