// Node --require entrypoint. This module lives in the installed CLI package,
// while framework resolution is anchored at the consumer's working directory.
const { createRequire } = require('node:module');
const consumerRequire = createRequire(`${process.cwd()}/package.json`);
let express = false;
try { consumerRequire.resolve('express'); express = true; } catch { /* generic Node path */ }
const options = {
  serviceName: process.env.OTEL_SERVICE_NAME || process.env.PERFLENS_SERVICE_NAME || 'perflens-node-service',
  serviceVersion: process.env.OTEL_SERVICE_VERSION,
  environment: process.env.DEPLOYMENT_ENVIRONMENT || 'local',
};
if (express) require('./express-instrumentation.cjs').startExpressInstrumentation(options);
else require('./instrumentation.cjs').startNodeInstrumentation(options);
