import { createRequire } from 'node:module';
import { startExpressInstrumentation } from './express';
import { startNodeInstrumentation } from './index';
import { startProcessResourceSampler } from './resources';

// Bundled by the CLI for temporary read-only delivery into consumer
// containers. Resolve Express from the consumer's cwd; never bundle app deps.
const consumerRequire = createRequire(`${process.cwd()}/package.json`);
let isExpress = false;
try { consumerRequire.resolve('express'); isExpress = true; } catch { /* generic supported Node target */ }

const options = {
  serviceName: process.env.OTEL_SERVICE_NAME || 'perflens-node-service',
  serviceVersion: process.env.OTEL_SERVICE_VERSION,
  environment: process.env.DEPLOYMENT_ENVIRONMENT || 'local',
};

if (isExpress) startExpressInstrumentation(options);
else startNodeInstrumentation(options);
startProcessResourceSampler({ directory: process.env.PERFLENS_RESOURCE_DIRECTORY });
