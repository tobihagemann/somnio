/** A job asked of a worker-backed seam and not yet answered. */
interface HeldJob<Inputs, Output> {
  inputs: Inputs;
  done: (output: Output) => void;
}

/**
 * Holds every job asked of a worker-backed seam until the test answers it, as a worker would answer
 * later. `run` stands in for the seam's one method, and `release` answers every job held, in the
 * order asked, with what `compute` makes of its inputs.
 */
export function heldJobs<Inputs, Output>(
  compute: (inputs: Inputs) => Output,
): { run: (inputs: Inputs, done: (output: Output) => void) => void; jobs: HeldJob<Inputs, Output>[]; release: () => void } {
  const jobs: HeldJob<Inputs, Output>[] = [];
  return {
    run: (inputs, done) => {
      jobs.push({ inputs, done });
    },
    jobs,
    release: () => {
      for (const job of jobs.splice(0)) job.done(compute(job.inputs));
    },
  };
}
