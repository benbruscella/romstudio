/** Coalesce changes received during a build into one following build. A
 * manifest must never be published by overlapping writers in one watcher. */
export function rebuildQueue(build: () => Promise<void>, failed: (error: unknown) => void) {
  let running = false,
    requested = false,
    closed = false;
  const drain = async () => {
    if (running || closed) {
      return;
    }
    running = true;
    try {
      while (requested && !closed) {
        requested = false;
        try {
          await build();
        } catch (error) {
          failed(error);
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    request() {
      if (!closed) {
        requested = true;
        void drain();
      }
    },
    close() {
      closed = true;
      requested = false;
    },
  };
}
