/*
 * sf-lifeline: run a command that dies the moment its parent process dies (RT-LIFE-06, macOS).
 *
 *   sf-lifeline <parent-pid> -- <command> [args...]
 *
 * macOS has no PR_SET_PDEATHSIG and no kill-on-close job object, so a SIGKILLed or crashed runtime
 * would leave its ffmpeg encoders running, reparented to launchd. This helper gives the macOS
 * platform layer (`childLifetime.wrap`) the Linux `setpriv --pdeathsig KILL` semantics:
 *
 *  1. If its parent is not <parent-pid> any more (the spawner died before the guarantee could be
 *     armed), it exits 125 without running the command, like the Linux parent-alive guard.
 *  2. It starts a watchdog (double fork, own session, stdio on /dev/null, re-exec'd as
 *     `sf-lifeline --watch <parent-pid> <pid>` so its command line names nothing but itself) that
 *     asks the kernel through kqueue (EVFILT_PROC NOTE_EXIT) to be told when <parent-pid> exits, and
 *     then SIGKILLs this process (its whole group when it leads one). It exits on its own as soon as
 *     this process exits.
 *  3. It marks every inherited descriptor above 2 close-on-exec (the `withoutInheritedHandles`
 *     guarantee: Electron's DevTools listener has no CLOEXEC) and execs the command IN PLACE.
 *
 * Because the command replaces this process, its pid, command line, parent, stdin/stdout/stderr,
 * signals and exit status are the command's own: the platform's suspend / throttle / group signals
 * and the encoder-lease identity check address the program itself, with nothing to forward.
 *
 * Exit codes of the helper itself: 125 = not run (usage error, parent already gone, watchdog could
 * not start), 126 = command found but not executable, 127 = command not found.
 *
 * Plain C, no dependencies: clang -O2 -mmacosx-version-min=14.0 -o sf-lifeline sf-lifeline.c
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define EXIT_NOT_RUN 125

static int parse_pid(const char *text, pid_t *out) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value <= 0 || value > INT_MAX) return -1;
  *out = (pid_t)value;
  return 0;
}

/* Every open descriptor >= 3 (read from /dev/fd; a bounded sweep when that cannot be listed). */
static void for_each_high_fd(void (*apply)(int fd)) {
  DIR *dir = opendir("/dev/fd");
  if (dir != NULL) {
    int own = dirfd(dir);
    int fds[4096];
    int count = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL && count < (int)(sizeof fds / sizeof fds[0])) {
      pid_t fd;
      if (parse_pid(entry->d_name, &fd) == 0 && fd > 2 && fd != own) fds[count++] = (int)fd;
    }
    closedir(dir);
    if (count < (int)(sizeof fds / sizeof fds[0])) {
      for (int i = 0; i < count; i++) apply(fds[i]);
      return;
    }
  }
  int max = getdtablesize();
  if (max < 0 || max > 65536) max = 65536;
  for (int fd = 3; fd < max; fd++) apply(fd);
}

static void set_cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  if (flags >= 0) (void)fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static void close_fd(int fd) { (void)close(fd); }

/* Parent pid of `pid` as the kernel sees it now, or -1 when `pid` is gone. */
static pid_t parent_of(pid_t pid) {
  struct proc_bsdshortinfo info;
  if (proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &info, PROC_PIDT_SHORTBSDINFO_SIZE) != PROC_PIDT_SHORTBSDINFO_SIZE) return -1;
  return (pid_t)info.pbsi_ppid;
}

static void kill_target(pid_t target) {
  /* A target that leads its own process group (spawned detached) takes its descendants with it. */
  if (getpgid(target) == target) (void)killpg(target, SIGKILL);
  (void)kill(target, SIGKILL);
}

/*
 * Watchdog body: wait for whichever of `parent` / `target` exits first; on the parent's exit,
 * SIGKILL the target. Never returns.
 */
static void watch(pid_t parent, pid_t target) {
  for (int sig = 1; sig < NSIG; sig++) {
    if (sig != SIGKILL && sig != SIGSTOP) (void)signal(sig, SIG_IGN);
  }
  int kq = kqueue();
  if (kq < 0) {
    /* No way to learn of the parent's exit: poll its liveness through the target's parent pid. */
    for (;;) {
      pid_t now = parent_of(target);
      if (now < 0) _exit(0);
      if (now != parent) {
        kill_target(target);
        _exit(0);
      }
      usleep(100 * 1000);
    }
  }
  struct kevent change;
  EV_SET(&change, target, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  if (kevent(kq, &change, 1, NULL, 0, NULL) < 0) _exit(0); /* target already gone */
  EV_SET(&change, parent, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  if (kevent(kq, &change, 1, NULL, 0, NULL) < 0) {
    /* ESRCH: the parent exited before the watch was armed. */
    kill_target(target);
    _exit(0);
  }
  /*
   * Armed. The parent may have exited between the caller's check and the line above while its pid
   * still answered (a zombie not yet reaped): the target's own parent pid tells, because the kernel
   * reparents the target the moment its parent exits.
   */
  pid_t now = parent_of(target);
  if (now < 0) _exit(0);
  if (now != parent) {
    kill_target(target);
    _exit(0);
  }
  for (;;) {
    struct kevent event;
    int n = kevent(kq, NULL, 0, &event, 1, NULL);
    if (n < 0) {
      if (errno == EINTR) continue;
      _exit(1);
    }
    if (n == 0) continue;
    if ((pid_t)event.ident == parent) kill_target(target);
    _exit(0);
  }
}

static void become_watchdog(const char *self_path, pid_t parent, pid_t target) {
  (void)setsid();
  for_each_high_fd(close_fd);
  int null_fd = open("/dev/null", O_RDWR);
  if (null_fd >= 0) {
    (void)dup2(null_fd, 0);
    (void)dup2(null_fd, 1);
    (void)dup2(null_fd, 2);
    if (null_fd > 2) (void)close(null_fd);
  }
  if (self_path != NULL) {
    char parent_text[16];
    char target_text[16];
    snprintf(parent_text, sizeof parent_text, "%d", (int)parent);
    snprintf(target_text, sizeof target_text, "%d", (int)target);
    char *const argv[] = {"sf-lifeline", "--watch", parent_text, target_text, NULL};
    execv(self_path, argv);
    /* Re-exec failed (binary replaced?): keep watching from this copy. */
  }
  watch(parent, target);
}

static int usage(void) {
  fprintf(stderr, "usage: sf-lifeline <parent-pid> -- <command> [args...]\n");
  return EXIT_NOT_RUN;
}

int main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "--watch") == 0) {
    pid_t parent;
    pid_t target;
    if (parse_pid(argv[2], &parent) != 0 || parse_pid(argv[3], &target) != 0) return usage();
    watch(parent, target);
  }
  if (argc < 4 || strcmp(argv[2], "--") != 0) return usage();
  pid_t parent;
  if (parse_pid(argv[1], &parent) != 0) return usage();
  if (getppid() != parent) {
    fprintf(stderr, "sf-lifeline: parent %d is gone (now %d); not running %s\n", (int)parent, (int)getppid(), argv[3]);
    return EXIT_NOT_RUN;
  }

  char self_path[PROC_PIDPATHINFO_MAXSIZE];
  const char *self = proc_pidpath(getpid(), self_path, sizeof self_path) > 0 ? self_path : NULL;
  pid_t target = getpid();
  pid_t mid = fork();
  if (mid < 0) {
    perror("sf-lifeline: fork");
    return EXIT_NOT_RUN;
  }
  if (mid == 0) {
    pid_t watchdog = fork();
    if (watchdog < 0) _exit(1);
    if (watchdog > 0) _exit(0);
    become_watchdog(self, parent, target);
    _exit(0);
  }
  int status = 0;
  while (waitpid(mid, &status, 0) < 0) {
    if (errno != EINTR) {
      perror("sf-lifeline: waitpid");
      return EXIT_NOT_RUN;
    }
  }
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    fprintf(stderr, "sf-lifeline: could not start the watchdog; not running %s\n", argv[3]);
    return EXIT_NOT_RUN;
  }

  for_each_high_fd(set_cloexec);
  execvp(argv[3], &argv[3]);
  int err = errno;
  fprintf(stderr, "sf-lifeline: %s: %s\n", argv[3], strerror(err));
  return err == ENOENT || err == ENOTDIR ? 127 : 126;
}
