export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function watchOwnerProcess(
  ownerPid: number,
  onOwnerExit: () => void | Promise<void>,
  options: {
    intervalMs?: number;
    isAlive?: (pid: number) => boolean;
  } = {},
): () => void {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) {
    return () => {};
  }
  const isAlive = options.isAlive ?? processIsAlive;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || isAlive(ownerPid)) return;
    stopped = true;
    clearInterval(timer);
    void onOwnerExit();
  }, options.intervalMs ?? 1_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
