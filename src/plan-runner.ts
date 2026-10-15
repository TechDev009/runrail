import {
  createStepCatalog,
  OrchestrationHost,
  type ArtifactPort,
  type EvidenceStore,
  type HostPolicy,
  type OrchestrationLimits,
  type RunPlan,
  type RunResult,
  type RunStatus,
  type StepCatalog,
  type CatalogStep,
} from "@nifrajs/coding-agent/orchestration"

export interface RunrailPlanRunnerOptions {
  readonly catalog: StepCatalog | Readonly<Record<string, CatalogStep>>
  readonly limits?: OrchestrationLimits
  readonly maxSteps?: number
  readonly maxDepth?: number
  readonly policy?: HostPolicy
}

export interface RunrailPlanRunOptions {
  readonly runId?: string
  readonly artifactPort?: ArtifactPort
  readonly store?: EvidenceStore
  readonly signal?: AbortSignal
}

/** Runrail's small facade over Nifra's declarative, bounded, evidence-only plan host. */
export class RunrailPlanRunner {
  readonly host: OrchestrationHost

  constructor(options: RunrailPlanRunnerOptions) {
    const catalog = isCatalog(options.catalog) ? options.catalog : createStepCatalog(options.catalog)
    this.host = new OrchestrationHost({
      catalog,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    })
  }

  submit(source: RunPlan | unknown, options: Omit<RunrailPlanRunOptions, "signal"> = {}): Promise<string> {
    return this.host.submit(source, options)
  }

  async run(source: RunPlan | unknown, options: RunrailPlanRunOptions = {}): Promise<RunResult> {
    const runId = await this.submit(source, options)
    if (options.signal?.aborted === true) {
      this.host.cancel(runId)
      return this.host.result(runId)
    }
    const abort = (): void => {
      if (this.host.inspect(runId).state !== "succeeded" && this.host.inspect(runId).state !== "failed" && this.host.inspect(runId).state !== "cancelled")
        this.host.cancel(runId)
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    this.host.start(runId)
    try {
      return await this.host.settled(runId)
    } finally {
      options.signal?.removeEventListener("abort", abort)
    }
  }

  inspect(runId: string): RunStatus {
    return this.host.inspect(runId)
  }

  pause(runId: string): void {
    this.host.pause(runId)
  }

  resume(runId: string): void {
    this.host.resume(runId)
  }

  cancel(runId: string): void {
    this.host.cancel(runId)
  }

  result(runId: string): Promise<RunResult> {
    return this.host.result(runId)
  }

  openBoundaryVector(runId: string): number {
    return this.host.openBoundaryVector(runId)
  }
}

function isCatalog(value: StepCatalog | Readonly<Record<string, CatalogStep>>): value is StepCatalog {
  return typeof (value as StepCatalog).get === "function" && Array.isArray((value as StepCatalog).keys)
}
