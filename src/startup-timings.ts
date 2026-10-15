/**
 * With `RUNRAIL_TIMINGS=1`, how long each startup phase took, on stderr: what a thread waits for
 * before its engine answers. Phase names and milliseconds only.
 */
export async function timed<T>(phase: string, run: () => Promise<T>): Promise<T> {
  if (process.env.RUNRAIL_TIMINGS !== "1") return await run()
  const started = performance.now()
  try {
    return await run()
  } finally {
    process.stderr.write(`[runrail-timing] ${phase} ${(performance.now() - started).toFixed(1)}ms\n`)
  }
}
