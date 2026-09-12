#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef __APPLE__
#error This installer supports macOS only.
#endif
#ifndef __aarch64__
#error This installer supports Apple Silicon only.
#endif

static int app_directory(const char *name, struct stat *info) {
  size_t length = strlen(name);
  return length > 4 && strcmp(name + length - 4, ".app") == 0
      && lstat(name, info) == 0 && S_ISDIR(info->st_mode);
}

static int sync_parent(const char *name) {
  char *copy = strdup(name);
  if (!copy) return -1;
  int fd = open(dirname(copy), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  free(copy);
  if (fd < 0) return -1;
  int result = fsync(fd);
  close(fd);
  return result;
}

int main(int argc, char **argv) {
  if (argc != 4 || (strcmp(argv[1], "swap") && strcmp(argv[1], "move"))) {
    fputs("Usage: rapp-work-installer swap|move SOURCE.app DESTINATION.app\n", stderr);
    return 64;
  }
  struct stat source, destination;
  if (!app_directory(argv[2], &source)) {
    fputs("Source must be a real application directory.\n", stderr);
    return 65;
  }
  unsigned int flags = RENAME_EXCL;
  if (strcmp(argv[1], "swap") == 0) {
    if (!app_directory(argv[3], &destination) || source.st_dev != destination.st_dev) {
      fputs("Atomic replacement requires real applications on one filesystem.\n", stderr);
      return 65;
    }
    flags = RENAME_SWAP;
  } else if (lstat(argv[3], &destination) == 0 || errno != ENOENT) {
    fputs("Move destination must not exist.\n", stderr);
    return 65;
  }
  if (renamex_np(argv[2], argv[3], flags) != 0) {
    perror("Atomic application replacement");
    return 1;
  }
  if (sync_parent(argv[2]) != 0 || sync_parent(argv[3]) != 0) {
    fputs("Replacement occurred; durability is uncertain. Reconcile the journal.\n", stderr);
    return 2;
  }
  puts("{\"schema\":\"rapp-work.atomic-replace/1\",\"committed\":true}");
  return 0;
}
