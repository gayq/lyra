export function backgroundTask<Input, Output>(
  createWorker: () => Worker,
  fallback: (input: Input) => Output | Promise<Output>,
) {
  let worker: Worker | null = null;
  let unavailable = false;
  let nextId = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      finish: (output: Output) => void;
      retry: () => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const stop = () => {
    clearTimeout(idleTimer);
    worker?.terminate();
    worker = null;
  };
  const fail = () => {
    unavailable = true;
    stop();
    const requests = [...pending.values()];
    pending.clear();
    for (const request of requests) {
      clearTimeout(request.timer);
      request.retry();
    }
  };

  return (input: Input): Promise<Output> => {
    if (
      unavailable ||
      typeof window === "undefined" ||
      typeof Worker === "undefined"
    ) {
      return Promise.resolve().then(() => fallback(input));
    }
    return new Promise<Output>((resolve, reject) => {
      const retry = () => {
        void Promise.resolve().then(() => fallback(input)).then(resolve, reject);
      };
      let registered = false;
      try {
        clearTimeout(idleTimer);
        if (!worker) {
          worker = createWorker();
          worker.onerror = fail;
          worker.onmessageerror = fail;
          worker.onmessage = (
            event: MessageEvent<{ id: number; output: Output; failed?: boolean }>,
          ) => {
            const request = pending.get(event.data.id);
            if (!request) return;
            pending.delete(event.data.id);
            clearTimeout(request.timer);
            if (event.data.failed) request.retry();
            else request.finish(event.data.output);
            if (!pending.size) idleTimer = setTimeout(stop, 30_000);
          };
        }
        const id = ++nextId;
        pending.set(id, {
          finish: resolve,
          retry,
          timer: setTimeout(fail, 30_000),
        });
        registered = true;
        worker.postMessage({ id, input });
      } catch {
        fail();
        if (!registered) retry();
      }
    });
  };
}