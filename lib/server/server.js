// Dyson uses self-signed certs and private CA so not able to validate cert
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * Import external libraries
 */
const { Service } = require('alfred-base');
const debug = require('debug')('Dyson:Server');

// Setup service options
const { version } = require('../../package.json');
const serviceName = require('../../package.json').description;
const namespace = require('../../package.json').name;

const options = {
  serviceName,
  namespace,
  serviceVersion: version,
};

// Bind api functions to base class
Object.assign(Service.prototype, require('../api/dyson/dyson'));

// Bind data collector functions to base class
Object.assign(Service.prototype, require('../collectors/dyson/purecool'));

// Create base service
const service = new Service(options);

async function setupServer() {
  // Setup service
  await service.createRestifyServer();

  // Apply api routes
  service.restifyServer.get('/sensor/:device', (req, res, next) =>
    service._sensors(req, res, next),
  );
  debug(`Added get '/sensor/:device' api`);

  service.restifyServer.get('/sensors/current', (req, res, next) =>
    service._current(req, res, next),
  );
  debug(`Added get '/sensors/current' api`);

  // Listen for api requests
  service.listen();

  if (process.env.MOCK === 'true') {
    this.logger.info('Mocking enabled, will not collect dyson sensor data');
  } else {
    service.devices = [];
    service._getDysonDeviceData(); // Collect Dyson Pure Cool device data
  }
}
setupServer();
