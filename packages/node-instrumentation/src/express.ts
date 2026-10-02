import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { NodeInstrumentationOptions, startNodeInstrumentation } from './index';

/** Express-specific opt-in adapter; keep this preload before loading Express or other instrumented modules. */
export function startExpressInstrumentation(options: NodeInstrumentationOptions = {}) {
  return startNodeInstrumentation({
    ...options,
    additionalInstrumentations: [new ExpressInstrumentation(), ...(options.additionalInstrumentations ?? [])],
  });
}
