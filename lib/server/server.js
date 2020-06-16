/**
 * Import external libraries
 */
const serviceHelper = require('alfred-helper');

/**
 * Import helper libraries
 */
const { version } = require('../../package.json');
const serviceName = require('../../package.json').description;
const virtualHost = require('../../package.json').name;
const APIroot = require('../api/root/root.js');
const APIdyson = require('../api/dyson/dyson.js');
const pureCool = require('../collectors/dyson/purecool.js');

global.APITraceID = '';

async function setupAndRun() {
  // Create restify server
  const server = await serviceHelper.setupRestifyServer(virtualHost, version);

  // Setup API middleware
  await serviceHelper.setupRestifyMiddleware(server, virtualHost);

  // Configure API end points
  APIroot.applyRoutes(server);
  APIdyson.applyRoutes(server);

  // Capture and process API errors
  await serviceHelper.captureRestifyServerErrors(server);

  // Start service and listen to requests
  server.listen(process.env.PORT, async () => {
    serviceHelper.log(
      'info',
      `${serviceName} has started`,
    );
    if (process.env.MOCK === 'true') {
      serviceHelper.log(
        'info',
        'Mocking enabled, will not setup monitors or schedules',
      );
    } else {
      await pureCool.getPureCoolData(); // Collect Dyson Pure Cool device data
    }
  });
}

setupAndRun();
