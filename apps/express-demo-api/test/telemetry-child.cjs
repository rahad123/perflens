const spans = [];
const processor = {
  onStart() {},
  onEnd(span) { spans.push(span); },
  forceFlush() { return Promise.resolve(); },
  shutdown() { return Promise.resolve(); },
};
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { startNodeInstrumentation } = require('@perflens/node-instrumentation');
const telemetry = startNodeInstrumentation({
  serviceName: 'perflens-test-express', serviceVersion: '9.8.7', environment: 'test',
  spanProcessors: [processor], additionalInstrumentations: [new ExpressInstrumentation()],
});

async function main() {
  // These imports happen only after instrumentation registration, as in the Compose command.
  const { createServer, get } = require('node:http');
  const { createApp } = require('../dist/app.js');
  const dependency = createServer((_req, res) => res.end('{"status":"ok"}'));
  await new Promise(resolve => dependency.listen(0, '127.0.0.1', resolve));
  const pool = { query: async () => ({ rows: [{ id: 1 }] }) };
  const app = createApp({ pool, dependencyUrl: `http://127.0.0.1:${dependency.address().port}/dependency` });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/performance/external-call`;
  await new Promise((resolve, reject) => get(url, { headers: {
    'X-PerfLens-Run-Id': 'pfl_20260930T120000000Z_123e4567-e89b-12d3-a456-426614174000',
    'X-PerfLens-Profile': 'normal',
  } }, response => { response.resume(); response.on('end', resolve); }).on('error', reject));
  await new Promise(resolve => setTimeout(resolve, 50));
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => dependency.close(resolve));
  await telemetry.shutdown();
  process.stdout.write(`${JSON.stringify(spans.map(span => ({
    name: span.name, kind: span.kind, spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId, traceId: span.spanContext().traceId,
    attributes: span.attributes, resource: span.resource.attributes,
  })))}\n`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
