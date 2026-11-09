interface JobRequest<Inputs> {
  id: number;
  inputs: Inputs;
}

interface JobReply<Output> {
  id: number;
  output: Output;
}

/**
 * Runs `compute` off the main thread in the module worker `spawn` creates on first use, and hands
 * each output to its job's `done`. The worker answers through `serveWorkerJobs`. Where there is no
 * `Worker` (Node and happy-dom) a job runs inline. A worker that fails, such as one whose chunk is
 * gone after a deploy, answers nothing, so what it held and every later job run inline instead.
 */
export function workerJobs<Inputs, Output>(spawn: () => Worker, compute: (inputs: Inputs) => Output): (inputs: Inputs, done: (output: Output) => void) => void {
  const inline = (inputs: Inputs, done: (output: Output) => void): void => done(compute(inputs));
  if (typeof Worker === 'undefined') return inline;
  let worker: Worker | undefined;
  let failed = false;
  let nextId = 0;
  const waiting = new Map<number, { inputs: Inputs; done: (output: Output) => void }>();
  const fail = (): void => {
    failed = true;
    worker?.terminate();
    const held = [...waiting.values()];
    waiting.clear();
    for (const { inputs, done } of held) inline(inputs, done);
  };
  return (inputs, done) => {
    if (failed) {
      inline(inputs, done);
      return;
    }
    if (worker === undefined) {
      worker = spawn();
      worker.onmessage = (event: MessageEvent<JobReply<Output>>) => {
        const job = waiting.get(event.data.id);
        waiting.delete(event.data.id);
        job?.done(event.data.output);
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
    }
    const id = nextId;
    nextId += 1;
    waiting.set(id, { inputs, done });
    const request: JobRequest<Inputs> = { id, inputs };
    worker.postMessage(request);
  };
}

/** The worker's half of `workerJobs`: answers each job with `compute`'s output, handing back the buffers `transfer` names without a copy. */
export function serveWorkerJobs<Inputs, Output>(compute: (inputs: Inputs) => Output, transfer: (output: Output) => Transferable[]): void {
  self.onmessage = (event: MessageEvent<JobRequest<Inputs>>) => {
    const { id, inputs } = event.data;
    const output = compute(inputs);
    const reply: JobReply<Output> = { id, output };
    self.postMessage(reply, { transfer: transfer(output) });
  };
}
