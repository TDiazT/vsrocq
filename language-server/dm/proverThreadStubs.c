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
   Thread.create.

   Two things below are about what happens when that stack runs out anyway,
   which no size prevents: an unbounded recursion reaches any guard page. Both
   have to hold for the overflow to arrive as a catchable Stack_overflow
   rather than as the death of the process, and one of them also gives a name
   to the residual case that no arrangement here survives. See the comments on
   each. */

/* Before any include, and before the caml headers pull in the system ones:
   pthread_getattr_np, used to record the prover thread's stack bounds, is a
   GNU extension and is not declared without this. */
#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#include <caml/mlvalues.h>
#include <caml/memory.h>
#include <caml/callback.h>
#include <caml/threads.h>

#ifndef _WIN32
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if defined(__linux__)
/* Which thread the prover thread is, and where its stack lies, recorded once
   from the thread itself. The handler further down compares a faulting
   address against these, and records them here rather than asking at fault
   time because on Linux there is no way to ask that is safe from a signal
   handler; see vsrocq_fault_could_be_overflow. macOS needs none of this --
   there the handler can ask the faulting thread directly. */
static pthread_t vsrocq_prover_thread;
static const char *vsrocq_prover_stack_high;
static const char *vsrocq_prover_stack_low;
static volatile sig_atomic_t vsrocq_prover_stack_valid = 0;

static void vsrocq_record_prover_stack(void)
{
  pthread_attr_t attr;
  void *base;
  size_t size;

  /* Safe here and not in the handler: this allocates and takes the thread's
     lock, on a thread that has just started and has its whole stack. The
     bounds it reports exclude the guard page, so the guard sits just below
     `low` -- within the slack the comparison allows for. */
  if (pthread_getattr_np(pthread_self(), &attr) != 0)
    return;
  if (pthread_attr_getstack(&attr, &base, &size) == 0) {
    vsrocq_prover_stack_low = (const char *) base;
    vsrocq_prover_stack_high = (const char *) base + size;
    vsrocq_prover_thread = pthread_self();
    vsrocq_prover_stack_valid = 1;
  }
  pthread_attr_destroy(&attr);
}
#endif

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
#if defined(__linux__)
  vsrocq_record_prover_stack();
#endif
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

#if (defined(__APPLE__) || defined(__linux__)) && !defined(_WIN32)

/* Two platforms reach the code below, for two different reasons, and the
   difference is worth having straight before reading it: on macOS this
   handler exists because the runtime is not told about the fault at all, and
   on Linux because it is told and declines to do anything with it.

   OCaml's stack-overflow detector is installed for SIGSEGV alone
   (runtime/signals_nat.c), which is the right signal everywhere except on a
   macOS secondary thread: the main thread's stack limit is an unmapped region,
   so overflowing it is KERN_INVALID_ADDRESS -> SIGSEGV, but a pthread's guard
   is an mprotect'd mapping, so overflowing that is KERN_PROTECTION_FAILURE ->
   SIGBUS, which nothing handles. Routing SIGBUS through that same detector is
   what makes an overflow on this thread arrive as a catchable Stack_overflow.

   Handing SIGBUS the detector directly is what does not work, and its failure
   is worse than the one it fixes. OCaml's handler ends with:

     } else {
       act.sa_handler = SIG_DFL;
       sigaction(SIGSEGV, &act, NULL);
     }

   -- deactivate ourselves and return, so that the retried instruction is
   fatal. Entered on SIGBUS that disarms a signal which is not the one being
   delivered, so the retry re-enters the same handler, which rejects again,
   without end: a server pinned at 100% CPU with no diagnostic, no log line
   and no death.

   That is not a hypothetical about bus errors on other platforms. The handler
   rejects any fault whose PC is outside OCaml code, and a stack overflow
   reaches the guard page from inside the runtime's own C often enough to be
   seen about one run in eight, whenever allocation falls at the wrong depth:
   caml_call_gc -> caml_alloc_small_dispatch -> caml_do_pending_actions_exn,
   measured with `sample` against a spinning server.

   So the handler below delegates, and then deals with what the runtime's does
   not: it decides for itself, from the prover thread's stack bounds, whether
   the fault could be an overflow at all, and it never lets a fault the
   runtime declined be retried against a handler that will decline it again.
   What it does not do is make that fault survivable -- see the rejection
   branch for why nothing better is available from here.

   On Linux none of that mirroring is needed and none of it happens: a guard
   page there is an unmapped region on every thread, so an overflow is SIGSEGV,
   the runtime is already installed on it, and the rejection path disarms the
   signal actually being delivered, so the retry is fatal rather than a loop.
   What Linux shares is the rejection itself -- the runtime declines a fault
   whose PC is in its own C there for exactly the same reason -- and what it
   had until this commit is no way to tell that death from any other SIGSEGV.
   It is silent: the process is gone with no diagnostic, no log line and
   nothing on stderr, and `died with SIGSEGV` is all a caller can say. Forced
   deterministically with the `c` case of audit/repro/stackoverflow in the
   parent repository, which is what these two paragraphs are read off.

   So this handler is installed on Linux too, wrapped around the runtime's own
   rather than mirrored onto a second signal, and there it changes exactly one
   thing: a fault the runtime declined *and* that landed on the prover thread's
   guard page now says so on the way out. Everything else -- a genuine
   segmentation fault, an overflow the runtime accepts, an overflow on any
   other thread -- takes the same path it took before, byte for byte, because
   the delegation is unconditional and only the message is gated.

   That gate is the point rather than a detail. The runtime declines a null
   dereference and a guard-page hit through the same branch, so a message
   printed on every declined SIGSEGV would name a genuine crash as this known
   shortfall -- and `knownDecline` in client/src/test/lsp/stackOverflow.test.ts
   would then wave that crash through. */

/* How far below the low end of the stack a fault may land and still be taken
   for an overflow. A megabyte is far more than the guard region (a page), and
   covers a frame large enough to step over it in one go. Erring high costs
   nothing: a fault the runtime then declines is fatal either way, and the
   only difference is which of the two messages below names it. Erring low
   would turn a real overflow into a crash. */
#define VSROCQ_STACK_FAULT_SLACK (1024 * 1024)

/* The runtime's SIGSEGV action, captured at install time: the detector to
   delegate to, and the action to put back if it disarms itself. */
static struct sigaction vsrocq_ocaml_segv_action;
static int vsrocq_ocaml_segv_action_valid = 0;

static void vsrocq_report(const char *message)
{
  /* write(2) rather than fprintf: this runs in a signal handler, on a thread
     whose stack has just run out. */
  ssize_t written = write(2, message, strlen(message));
  (void) written;
}

/* Restore the default action for the signal being delivered, and return. The
   faulting instruction is retried, faults again, and this time the process
   dies of it -- which is what the runtime's rejection path intends, and does
   not achieve when it is entered on a signal other than SIGSEGV. */
static void vsrocq_fatal_on_retry(int signo)
{
  struct sigaction act;
  sigemptyset(&act.sa_mask);
  act.sa_flags = 0;
  act.sa_handler = SIG_DFL;
  sigaction(signo, &act, NULL);
}

/* Whether `addr` is near enough to a thread's stack for the fault to be an
   overflow rather than an unrelated fault at an unrelated address.

   Where the bounds come from differs by platform, and only because what is
   safe to call from here does. macOS can ask the faulting thread itself:
   pthread_get_stackaddr_np reads the thread's own descriptor, allocates
   nothing and takes no lock. Linux has no equivalent -- pthread_getattr_np
   locks the thread and allocates (for the affinity mask it fills in on the
   way), and for the initial thread it opens and parses /proc/self/maps --
   none of which is available on a thread whose stack has just run out, and
   the last of which can deadlock outright if the fault happened inside
   malloc. So Linux answers from the bounds the trampoline recorded when it
   started, and answers `no` for any other thread rather than guessing. */
static int vsrocq_fault_could_be_overflow(const void *addr)
{
  const char *high, *low;

#if defined(__APPLE__)
  pthread_t self = pthread_self();
  high = (const char *) pthread_get_stackaddr_np(self);
  low = high - pthread_get_stacksize_np(self);
#else
  if (!vsrocq_prover_stack_valid
      || !pthread_equal(pthread_self(), vsrocq_prover_thread))
    return 0;
  high = vsrocq_prover_stack_high;
  low = vsrocq_prover_stack_low;
#endif

  return (const char *) addr < high
      && (const char *) addr >= low - VSROCQ_STACK_FAULT_SLACK;
}

static void vsrocq_stack_fault_handler(int sig, siginfo_t *info, void *context)
{
  struct sigaction segv_now;
  int could_be_overflow;

  if (!vsrocq_ocaml_segv_action_valid) {
    vsrocq_fatal_on_retry(sig);
    return;
  }

  could_be_overflow =
    info != NULL && vsrocq_fault_could_be_overflow(info->si_addr);

#if defined(__APPLE__)
  if (!could_be_overflow) {
    /* A genuine bus error: a truncated mapping, a misaligned access. Nothing
       to do with the stack, so it stays as fatal and as prompt as it would
       have been with no handler installed at all -- and, more to the point,
       is never handed to a detector that would decline it and loop.

       No such branch on Linux, and there must not be one: there this handler
       sits on the signal the runtime installed itself on, so declining to
       delegate would take away the stack-overflow detection every other
       thread relies on. The gate is applied to the message instead, below. */
    vsrocq_fatal_on_retry(sig);
    return;
  }
#endif

  if (vsrocq_ocaml_segv_action.sa_flags & SA_SIGINFO)
    vsrocq_ocaml_segv_action.sa_sigaction(sig, info, context);
  else
    vsrocq_ocaml_segv_action.sa_handler(sig);

  /* Reaching here means the handler returned, which it does in two entirely
     different situations. On the accepted path it has rewritten the PC in
     `context` to caml_stack_overflow (RETURN_AFTER_STACK_OVERFLOW, which is
     how macOS and Linux/arm64 are built), so returning from here raises
     Stack_overflow in the OCaml code that overflowed -- as intended, and as
     often as it happens. On the rejected path it has instead set SIGSEGV to
     SIG_DFL, and that side effect is the one thing that tells the two apart:
     the accepted path never touches SIGSEGV.

     Where RETURN_AFTER_STACK_OVERFLOW is not defined -- Linux/amd64, the
     platform this matters on -- the accepted path does not return here at
     all: it raises from inside the runtime's handler and never comes back. So
     there the test below is not so much a discriminator as a formality, but
     it is written the same way for both, because which of the two the
     accepted path takes is the runtime's business and not ours. */
  if (sigaction(SIGSEGV, NULL, &segv_now) == 0
      && (segv_now.sa_flags & SA_SIGINFO) == 0
      && segv_now.sa_handler == SIG_DFL) {
    /* Undo the disarming: on macOS it was aimed at a signal that is not the
       one being delivered, and leaving SIGSEGV defaulted would quietly cost
       the main thread its own overflow detection. On Linux the disarming was
       aimed at this very signal and undoing it here changes nothing, since
       the call below puts SIG_DFL straight back. */
    sigaction(SIGSEGV, &vsrocq_ocaml_segv_action, NULL);

    /* Name the death, but only for a fault that reached the prover thread's
       guard page. The runtime declines a null dereference through this same
       branch, and a message here would label that as the documented shortfall
       -- which is not cosmetic: `knownDecline` in the LSP suite reads exactly
       this message to decide which death to step aside for. */
    if (could_be_overflow)
      /* Dying rather than retrying. The runtime declines this fault because
         the PC is not in OCaml code, and that refusal is right: the raise it
         would otherwise perform resumes into caml_stack_overflow with the
         OCaml exception pointer and young_ptr read out of the machine
         registers, which hold no such thing in the middle of a C frame. There
         is nothing here that can be resumed safely, so the choice is between
         dying and looping, and dying can at least say why. */
      vsrocq_report(
        "vsrocqtop: fatal: the prover thread ran out of stack inside the OCaml "
        "runtime rather than in OCaml code.\n"
        "The runtime cannot turn that one into an exception, so it ends the "
        "process rather than a sentence. See dm/proverThreadStubs.c.\n");

    vsrocq_fatal_on_retry(sig);
  }
}

#endif

/* The other half of making an overflow on this thread survivable, and on
   Linux of making the one it cannot survive say so: installs the handler
   above, and is a no-op anywhere else.

   Which signal it goes on is the whole platform difference. On macOS the
   runtime never hears about a secondary thread's guard page, so the handler
   is *mirrored* onto SIGBUS and SIGSEGV is left exactly as the runtime set
   it. On Linux the runtime is already on the right signal, so the handler
   *wraps* SIGSEGV and delegates to what it replaced. */
#if defined(__APPLE__)
#define VSROCQ_FAULT_SIGNAL SIGBUS
#else
#define VSROCQ_FAULT_SIGNAL SIGSEGV
#endif

CAMLprim value vsrocq_report_thread_stack_overflow(value unit)
{
  CAMLparam1(unit);
#if (defined(__APPLE__) || defined(__linux__)) && !defined(_WIN32)
  struct sigaction installed, ours;

  /* Whatever the runtime put on SIGSEGV, taken as it stands rather than
     rebuilt, so that this follows the runtime's own choice of flags. If it
     put nothing there -- a build without stack-overflow detection -- there is
     nothing to delegate to and nothing worth installing. */
  if (sigaction(SIGSEGV, NULL, &installed) != 0)
    CAMLreturn(Val_unit);
  if (!(installed.sa_flags & SA_SIGINFO)
      && (installed.sa_handler == SIG_DFL || installed.sa_handler == SIG_IGN))
    CAMLreturn(Val_unit);

  vsrocq_ocaml_segv_action = installed;
  vsrocq_ocaml_segv_action_valid = 1;

  ours = installed;
  ours.sa_sigaction = vsrocq_stack_fault_handler;
  /* SA_ONSTACK because the handler has to run on the alternate stack the
     trampoline set up, this thread's own having just run out. SA_NODEFER as
     the runtime uses it, so that the signal is not left blocked by an overflow
     that leaves the handler by raising rather than by returning -- without it
     a session survives its first overflow and dies of its second. Both are
     already set on what the runtime installed, so on Linux, where this wraps
     that very action, the flags come back identical to the ones replaced. */
  ours.sa_flags = installed.sa_flags | SA_SIGINFO | SA_ONSTACK | SA_NODEFER;
  sigemptyset(&ours.sa_mask);
  sigaction(VSROCQ_FAULT_SIGNAL, &ours, NULL);
#endif
  CAMLreturn(Val_unit);
}
