/*
 * libcwh-nodelete: production's "delete needs the user's permission" for the device container.
 *
 * Production mounts a connected folder read-write without delete: an unlink or rmdir in it fails with "Operation
 * not permitted" until the user allows deletion for that folder. A rename inside one folder works, also over an
 * existing file; a move between folders is cross-device, so `mv` copies and then cannot remove the source; deleting
 * a missing file still reports it missing. This library, preloaded into every process through /etc/ld.so.preload,
 * does the same for the libc calls that delete or rename. A static binary or a raw system call is not covered: the
 * harness compares the device tree before and after the run for that.
 *
 * Control files (written by the harness on the host; the device user cannot change them):
 *   /run/cwh-device/ctl/folders  one line per folder: name TAB mode TAB absolute path; "/mnt" names the folders'
 *                                parent. Only mode "rw" refuses deletes ("rwd" allows them; "r" is a read-only
 *                                mount already).
 *   /run/cwh-device/ctl/grants   one folder name per line, appended when the user allows deletion; re-read on
 *                                every would-be refusal, so a grant applies from the next call.
 * Each refused or granted delete appends one JSON line to /run/cwh-device/audit/audit.jsonl.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define CTL_FOLDERS "/run/cwh-device/ctl/folders"
#define CTL_GRANTS "/run/cwh-device/ctl/grants"
#define AUDIT_LOG "/run/cwh-device/audit/audit.jsonl"
#define MAX_FOLDERS 64
#define MAX_FILE 65536

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif

struct folder {
  char name[256];
  char mode[8];
  char path[PATH_MAX];
};

struct ctl {
  int n;
  int ok; /* the folders file was read */
  char mnt[PATH_MAX];
  struct folder f[MAX_FOLDERS];
};

/* Reads a small control file with raw open/read, which this library does not interpose. */
static ssize_t read_small(const char *path, char *buf, size_t cap) {
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  size_t got = 0;
  while (got < cap - 1) {
    ssize_t r = read(fd, buf + got, cap - 1 - got);
    if (r < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return -1;
    }
    if (r == 0) break;
    got += (size_t)r;
  }
  close(fd);
  buf[got] = '\0';
  return (ssize_t)got;
}

/* mmap, not malloc or a static: libuv and other thread pools delete from worker threads, git unlinks its lock
 * files from a signal handler (where malloc is unsafe), and these structures are too large for a thread's stack. */
static void *page_alloc(size_t n) {
  void *p = mmap(NULL, n, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  return p == MAP_FAILED ? NULL : p;
}
#define ctl_free(c) \
  do {                \
    if (c) munmap((c), sizeof(struct ctl)); \
  } while (0)

static struct ctl *load_ctl(void) {
  struct ctl *c = page_alloc(sizeof *c); /* zero-filled */
  char *buf = page_alloc(MAX_FILE);
  if (!c || !buf) {
    if (buf) munmap(buf, MAX_FILE);
    return c; /* c->ok stays 0: fail closed below */
  }
  if (read_small(CTL_FOLDERS, buf, MAX_FILE) < 0) {
    munmap(buf, MAX_FILE);
    return c;
  }
  c->ok = 1;
  char *save = NULL;
  for (char *line = strtok_r(buf, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
    char *t1 = strchr(line, '\t');
    if (!t1) continue;
    char *t2 = strchr(t1 + 1, '\t');
    if (!t2) continue;
    *t1 = '\0';
    *t2 = '\0';
    if (strcmp(line, "/mnt") == 0) {
      snprintf(c->mnt, sizeof c->mnt, "%s", t2 + 1);
      continue;
    }
    if (c->n >= MAX_FOLDERS) continue;
    struct folder *f = &c->f[c->n++];
    snprintf(f->name, sizeof f->name, "%s", line);
    snprintf(f->mode, sizeof f->mode, "%s", t1 + 1);
    snprintf(f->path, sizeof f->path, "%s", t2 + 1);
  }
  munmap(buf, MAX_FILE);
  return c;
}

static int granted(const char *name) {
  char *buf = page_alloc(MAX_FILE);
  int found = 0;
  if (!buf) return 0;
  if (read_small(CTL_GRANTS, buf, MAX_FILE) >= 0) {
    char *save = NULL;
    for (char *line = strtok_r(buf, "\n", &save); line && !found; line = strtok_r(NULL, "\n", &save))
      if (strcmp(line, name) == 0) found = 1;
  }
  munmap(buf, MAX_FILE);
  return found;
}

/* `p` equals `root` or lies beneath it (a prefix only at a path boundary). */
static int under(const char *p, const char *root) {
  size_t n = strlen(root);
  return n > 0 && strncmp(p, root, n) == 0 && (p[n] == '\0' || p[n] == '/');
}

/* The folder holding `p`, or -1. */
static int folder_of(const struct ctl *c, const char *p) {
  for (int i = 0; i < c->n; i++)
    if (under(p, c->f[i].path)) return i;
  return -1;
}

static int is_root(const struct ctl *c, const char *p) {
  if (c->mnt[0] && strcmp(p, c->mnt) == 0) return 1;
  for (int i = 0; i < c->n; i++)
    if (strcmp(p, c->f[i].path) == 0) return 1;
  return 0;
}

/* The absolute path `path` names relative to `dirfd`, with its parent resolved (symlinks, `..`) and the leaf kept
 * as written: deleting a symlink deletes the link, not its target. 0 on success; -1 when the parent does not
 * resolve, which the real call then reports itself; -2 when the path is too long to resolve here, though a call
 * relative to a deep directory could still reach it. */
static int resolve_path(int dirfd, const char *path, char *out, size_t cap) {
  char joined[PATH_MAX * 2];
  if (path[0] == '/') {
    int j = snprintf(joined, sizeof joined, "%s", path);
    if (j < 0 || (size_t)j >= sizeof joined) return -2;
  } else {
    char base[PATH_MAX];
    if (dirfd == AT_FDCWD) {
      if (!getcwd(base, sizeof base)) return -2;
    } else {
      char link[64];
      snprintf(link, sizeof link, "/proc/self/fd/%d", dirfd);
      ssize_t n = readlink(link, base, sizeof base - 1);
      if (n < 0) return -1;
      if ((size_t)n >= sizeof base - 1) return -2;
      base[n] = '\0';
    }
    int j = snprintf(joined, sizeof joined, "%s/%s", base, path);
    if (j < 0 || (size_t)j >= sizeof joined) return -2;
  }
  size_t len = strlen(joined);
  while (len > 1 && joined[len - 1] == '/') joined[--len] = '\0';
  char *slash = strrchr(joined, '/');
  const char *leaf = slash + 1;
  char parent[PATH_MAX];
  if (slash == joined) snprintf(parent, sizeof parent, "/");
  else {
    *slash = '\0';
    if (!realpath(joined, parent)) return errno == ENAMETOOLONG ? -2 : -1;
  }
  if (strcmp(leaf, ".") == 0 || strcmp(leaf, "..") == 0 || leaf[0] == '\0') {
    /* `rmdir d/.` and the like: the target is the parent itself (or above). */
    char full[PATH_MAX * 2];
    snprintf(full, sizeof full, "%s/%s", parent, leaf);
    if (!realpath(full, out)) return errno == ENAMETOOLONG ? -2 : -1;
    return 0;
  }
  int n = snprintf(out, cap, "%s%s%s", parent, strcmp(parent, "/") == 0 ? "" : "/", leaf);
  return n < 0 || (size_t)n >= cap ? -2 : 0;
}

/* `s` as a JSON string body. */
static void json_escape(const char *s, char *out, size_t cap) {
  size_t j = 0;
  for (; *s && j < cap - 8; s++) {
    unsigned char ch = (unsigned char)*s;
    if (ch == '"' || ch == '\\') {
      out[j++] = '\\';
      out[j++] = (char)ch;
    } else if (ch < 0x20) {
      j += (size_t)snprintf(out + j, cap - j, "\\u%04x", ch);
    } else out[j++] = (char)ch;
  }
  out[j] = '\0';
}

static void audit(const char *op, const char *folder, const char *rel, const char *result) {
  char line[PATH_MAX * 2 + 1024];
  char esc[PATH_MAX * 2];
  char fesc[600];
  json_escape(rel, esc, sizeof esc);
  json_escape(folder, fesc, sizeof fesc);
  int n = snprintf(line, sizeof line, "{\"op\":\"%s\",\"folder\":\"%s\",\"rel\":\"%s\",\"result\":\"%s\",\"pid\":%d}\n", op, fesc, esc, result,
                   (int)getpid());
  if (n <= 0) return;
  int fd = open(AUDIT_LOG, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0644);
  if (fd < 0) return;
  ssize_t w = write(fd, line, (size_t)n < sizeof line ? (size_t)n : sizeof line - 1);
  (void)w;
  close(fd);
}

/* Decide a delete. Returns 1 to call through (with *granted_folder set when the call is a granted delete to log),
 * 0 when refused here (errno set). */
/* For a path too deep to resolve as a string (a short name relative to a deep directory): the folder its parent
 * lies in, found by walking up from the parent directory itself and comparing each ancestor with the folder roots
 * by device and inode, so no symlink can mislead it. -1 for none; -2 when it cannot tell. */
static int deep_folder_of(const struct ctl *c, int dirfd, const char *path) {
  char parent[PATH_MAX];
  int n = snprintf(parent, sizeof parent, "%s", path);
  if (n < 0 || (size_t)n >= sizeof parent) return -2;
  char *slash = strrchr(parent, '/');
  if (slash) *slash = '\0';
  else snprintf(parent, sizeof parent, ".");
  int fd = openat(dirfd, parent[0] ? parent : "/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return -2;
  struct stat roots[MAX_FOLDERS];
  for (int i = 0; i < c->n; i++)
    if (stat(c->f[i].path, &roots[i]) != 0) roots[i].st_ino = 0;
  for (int depth = 0; depth < PATH_MAX; depth++) {
    struct stat st;
    if (fstat(fd, &st) != 0) break;
    for (int i = 0; i < c->n; i++)
      if (roots[i].st_ino && roots[i].st_ino == st.st_ino && roots[i].st_dev == st.st_dev) {
        close(fd);
        return i;
      }
    int up = openat(fd, "..", O_PATH | O_DIRECTORY | O_CLOEXEC);
    struct stat ust;
    if (up < 0 || fstat(up, &ust) != 0) {
      if (up >= 0) close(up);
      break;
    }
    close(fd);
    fd = up;
    if (ust.st_ino == st.st_ino && ust.st_dev == st.st_dev) {
      close(fd);
      return -1; /* reached / */
    }
  }
  close(fd);
  return -2;
}

enum del_kind { DEL_UNLINK, DEL_RMDIR, DEL_REMOVE };

/* Decide a delete. Returns 1 to call through (with *fi_out set when the call is a granted delete to log), 0 when
 * refused here (errno set). The kernel's own answers come first, as they would for a refusal production's mount
 * makes: a missing file is missing, `unlink` of a directory is EISDIR, `rmdir` of a file ENOTDIR. */
static int delete_allowed(const char *op, enum del_kind kind, int dirfd, const char *path, int *fi_out, struct ctl *c, char *full) {
  int saved = errno;
  *fi_out = -1;
  if (!path || !*path) {
    errno = ENOENT;
    return 0;
  }
  size_t plen = strlen(path);
  /* `unlink("x/")` never deletes (ENOTDIR or EISDIR): the kernel answers it. */
  if (kind == DEL_UNLINK && path[plen - 1] == '/') {
    errno = saved;
    return 1;
  }
  int resolved = resolve_path(dirfd, path, full, PATH_MAX);
  int fi;
  if (resolved == -2) {
    /* Too deep to place by name. An absolute or over-long name fails in the kernel anyway; a short name under a
     * deep directory is placed by walking up from it. */
    if (path[0] == '/' || plen >= PATH_MAX) {
      errno = saved;
      return 1;
    }
    if (!c || !c->ok) fi = -2;
    else {
      fi = deep_folder_of(c, dirfd, path);
      if (fi == -1 || (fi >= 0 && strcmp(c->f[fi].mode, "rw") != 0)) {
        errno = saved;
        return 1;
      }
      if (fi >= 0 && granted(c->f[fi].name)) {
        errno = saved;
        return 1;
      }
    }
    errno = EPERM;
    return 0;
  }
  if (resolved != 0) {
    errno = saved;
    return 1;
  }
  if (!c || !c->ok) {
    /* No control file: refuse every delete under a session's mnt rather than enforce nothing. */
    if (strncmp(full, "/sessions/", 10) == 0 && strstr(full, "/mnt/")) fi = -2;
    else {
      errno = saved;
      return 1;
    }
  } else {
    fi = folder_of(c, full);
    if (fi < 0 || strcmp(c->f[fi].mode, "rw") != 0) {
      errno = saved;
      return 1;
    }
    if (granted(c->f[fi].name)) {
      *fi_out = fi;
      errno = saved;
      return 1;
    }
  }
  struct stat st;
  if (lstat(full, &st) != 0) {
    errno = ENOENT;
    return 0;
  }
  if (kind == DEL_UNLINK && S_ISDIR(st.st_mode)) {
    errno = EISDIR;
    return 0;
  }
  if (kind == DEL_RMDIR && !S_ISDIR(st.st_mode)) {
    errno = ENOTDIR;
    return 0;
  }
  if (fi >= 0) {
    const char *root = c->f[fi].path;
    const char *rel = full + strlen(root);
    if (*rel == '/') rel++;
    audit(op, c->f[fi].name, rel, "refused");
  }
  errno = EPERM;
  return 0;
}

static void log_granted(const char *op, const struct ctl *c, int fi, const char *full, int rc) {
  if (fi < 0) return;
  const char *rel = full + strlen(c->f[fi].path);
  if (*rel == '/') rel++;
  audit(op, c->f[fi].name, rel, rc == 0 ? "granted" : "granted-failed");
}

typedef int (*unlinkat_fn)(int, const char *, int);
typedef int (*path_fn)(const char *);
typedef int (*rename_fn)(const char *, const char *);
typedef int (*renameat_fn)(int, const char *, int, const char *);
typedef int (*renameat2_fn)(int, const char *, int, const char *, unsigned int);

#define REAL(name, type) \
  static type real_##name; \
  if (!real_##name) real_##name = (type)dlsym(RTLD_NEXT, #name)

int unlinkat(int dirfd, const char *path, int flags) {
  REAL(unlinkat, unlinkat_fn);
  struct ctl *c = load_ctl();
  char full[PATH_MAX];
  int fi;
  const char *op = (flags & AT_REMOVEDIR) ? "rmdir" : "unlinkat";
  if (!delete_allowed(op, (flags & AT_REMOVEDIR) ? DEL_RMDIR : DEL_UNLINK, dirfd, path, &fi, c, full)) {
    ctl_free(c);
    return -1;
  }
  int rc = real_unlinkat(dirfd, path, flags);
  int e = errno;
  log_granted(op, c, fi, full, rc);
  ctl_free(c);
  errno = e;
  return rc;
}

int unlink(const char *path) {
  REAL(unlink, path_fn);
  struct ctl *c = load_ctl();
  char full[PATH_MAX];
  int fi;
  if (!delete_allowed("unlink", DEL_UNLINK, AT_FDCWD, path, &fi, c, full)) {
    ctl_free(c);
    return -1;
  }
  int rc = real_unlink(path);
  int e = errno;
  log_granted("unlink", c, fi, full, rc);
  ctl_free(c);
  errno = e;
  return rc;
}

int rmdir(const char *path) {
  REAL(rmdir, path_fn);
  struct ctl *c = load_ctl();
  char full[PATH_MAX];
  int fi;
  if (!delete_allowed("rmdir", DEL_RMDIR, AT_FDCWD, path, &fi, c, full)) {
    ctl_free(c);
    return -1;
  }
  int rc = real_rmdir(path);
  int e = errno;
  log_granted("rmdir", c, fi, full, rc);
  ctl_free(c);
  errno = e;
  return rc;
}

/* glibc's remove() calls its internal unlink/rmdir directly, past the symbols above. */
int remove(const char *path) {
  REAL(remove, path_fn);
  struct ctl *c = load_ctl();
  char full[PATH_MAX];
  int fi;
  if (!delete_allowed("remove", DEL_REMOVE, AT_FDCWD, path, &fi, c, full)) {
    ctl_free(c);
    return -1;
  }
  int rc = real_remove(path);
  int e = errno;
  log_granted("remove", c, fi, full, rc);
  ctl_free(c);
  errno = e;
  return rc;
}

/* A rename stays inside one folder: across a folder boundary it is cross-device (EXDEV, so `mv` falls back to a
 * copy and an unlink, which is then refused), and a folder root or the folders' parent cannot be renamed (EBUSY,
 * as a mount point). */
static int rename_allowed(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
  int saved = errno;
  struct ctl *c = load_ctl();
  int verdict = 1;
  if (!c || !c->ok) {
    ctl_free(c);
    errno = saved;
    return 1;
  }
  char from[PATH_MAX], to[PATH_MAX];
  int rf = resolve_path(olddirfd, oldpath, from, sizeof from);
  int rt = resolve_path(newdirfd, newpath, to, sizeof to);
  if (rf == -2 || rt == -2) {
    /* Too deep to place: treat it as crossing a folder boundary. */
    verdict = 0;
    saved = EXDEV;
  } else if (rf != 0 || rt != 0) {
    /* unresolvable: the real call reports it */
  } else if (is_root(c, from) || is_root(c, to)) {
    verdict = 0;
    saved = EBUSY;
  } else if (folder_of(c, from) != folder_of(c, to)) {
    verdict = 0;
    saved = EXDEV;
  }
  ctl_free(c);
  errno = saved;
  return verdict;
}

int rename(const char *oldpath, const char *newpath) {
  REAL(rename, rename_fn);
  if (!rename_allowed(AT_FDCWD, oldpath, AT_FDCWD, newpath)) return -1;
  return real_rename(oldpath, newpath);
}

int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
  REAL(renameat, renameat_fn);
  if (!rename_allowed(olddirfd, oldpath, newdirfd, newpath)) return -1;
  return real_renameat(olddirfd, oldpath, newdirfd, newpath);
}

int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags) {
  REAL(renameat2, renameat2_fn);
  if (!rename_allowed(olddirfd, oldpath, newdirfd, newpath)) return -1;
  return real_renameat2(olddirfd, oldpath, newdirfd, newpath, flags);
}
