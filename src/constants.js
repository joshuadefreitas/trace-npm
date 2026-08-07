export const STRACE_FLAGS = ["-f", "-qq", "-s", "4096", "-yy", "-e", "trace=file,process,network"];

export const SYSTEM_FILE_PREFIXES = [
  "/usr/lib",
  "/usr/share",
  "/lib",
  "/etc/ld.so",
  "/proc",
  "/sys",
  "/dev"
];
