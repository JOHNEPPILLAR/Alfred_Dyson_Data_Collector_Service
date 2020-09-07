/**
 * Import external libraries
 */
const mqtt = require('mqtt');
const crypto = require('crypto');

const poolingInterval = 5 * 60 * 1000; // 5 minutes

/**
 * Save data to data store
 */
async function saveDeviceData(sqlValues) {
  try {
    const sql =
      'INSERT INTO dyson_purecool("time", sender, location, air, temperature, humidity, nitrogen) VALUES ($1, $2, $3, $4, $5, $6, $7)';
    const dbConnection = await this._connectToDB('dyson');
    this.logger.trace(`${this._traceStack()} - Save sensor values`);
    const results = await dbConnection.query(sql, sqlValues);
    this.logger.trace(
      `${this._traceStack()} - Release the data store connection back to the pool`,
    );
    await dbConnection.end(); // Close data store connection

    if (results.rowCount !== 1) {
      this.logger.error(
        `${this._traceStack()} - Failed to insert data for device ${
          sqlValues[2]
        }`,
      );
      return;
    }
    this.logger.info(`Saved data for device ${sqlValues[2]}`);
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  }
}

function getCharacteristicValue(rawValue) {
  if (!rawValue) return 0;
  const integerValue = Number.parseInt(rawValue, 10);

  // Reduces the scale from 0-100 to 0-10 as used in the Dyson app
  // integerValue = Math.floor(integerValue / 10);

  return integerValue;
}

// Converts the raw value into an integer
function getNumericValue(rawValue) {
  if (!rawValue) return 0;
  return Number.parseInt(rawValue, 10);
}

async function processData(device) {
  const dysonUserName = device.Serial;
  const model = device.name.substring(0, 3);
  const dysonIP = device.referer.address;

  let mqttClient;

  this.logger.trace(
    `${this._traceStack()} - Processing device: ${device.friendlyName} (${
      device.Serial
    })`,
  );

  try {
    const key = Uint8Array.from(Array(32), (_, index) => index + 1);
    const initializationVector = new Uint8Array(16);
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      key,
      initializationVector,
    );
    const decryptedPasswordString =
      decipher.update(device.LocalCredentials, 'base64', 'utf8') +
      decipher.final('utf8');
    const decryptedPasswordJson = JSON.parse(decryptedPasswordString);
    const dysonPassword = decryptedPasswordJson.apPasswordHash;
    const mqttClientOptions = {
      username: dysonUserName,
      password: dysonPassword,
      clientId: 'alfred_dynson',
    };

    if (model === 438) {
      mqttClientOptions.protocolVersion = 3;
      mqttClientOptions.protocolId = 'MQIsdp';
    }

    this.logger.trace(
      `${this._traceStack()} - Connecting to Dyson device: ${
        device.friendlyName
      } on ${dysonIP}`,
    );
    mqttClient = await mqtt.connect(`mqtt://${dysonIP}`, mqttClientOptions);
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  }

  mqttClient.on('error', (err) => {
    if (
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('Identifier rejected')
    ) {
      this.logger.error(
        `${this._traceStack()} - Connection error: ${device.friendlyName} (${
          device.Serial
        }): ${err.message}`,
      );
      mqttClient.end();
      mqttClient = null;

      this.logger.error(
        `${this._traceStack()} - Remove device ${device.friendlyName} (${
          device.Serial
        }) from cache`,
      );
      this.devices = this.devices.filter((d) => d.Serial !== device.Serial);
    } else {
      this.logger.error(`${this._traceStack()} - ${err.message}`);
    }
  });

  mqttClient.on('connect', async () => {
    this.logger.trace(
      `${this._traceStack()} - Connected to device: ${
        device.friendlyName
      } (${dysonUserName})`,
    );
    const statusSubscribeTopic = `${model}/${dysonUserName}/status/current`;
    await mqttClient.subscribe(statusSubscribeTopic);

    this.logger.trace(
      `${this._traceStack()} - Force state update for device: ${
        device.friendlyName
      } (${dysonUserName})`,
    );
    const commandTopic = `${model}/${dysonUserName}/command`;
    const currentTime = new Date();
    await mqttClient.publish(
      commandTopic,
      JSON.stringify({
        msg: 'REQUEST-CURRENT-STATE',
        time: currentTime.toISOString(),
      }),
    );
  });

  mqttClient.on('message', async (topic, message) => {
    const deviceData = JSON.parse(message);
    if (deviceData.msg === 'ENVIRONMENTAL-CURRENT-SENSOR-DATA') {
      this.logger.trace(
        `${this._traceStack()} - Got sensor data from device: ${
          device.friendlyName
        } (${dysonUserName})`,
      );

      // All models
      const tact = getCharacteristicValue(deviceData.data.tact);
      const temperature = Number.parseFloat(tact) / 10 - 273;

      const hact = getCharacteristicValue(deviceData.data.hact);
      // eslint-disable-next-line radix
      const humidity = Number.parseInt(hact);

      // const sltm = getCharacteristicValue(deviceData.data.sltm);
      // const silantMode = sltm;

      // Model 455
      const pact = getCharacteristicValue(deviceData.data.pact);
      const vact = getCharacteristicValue(deviceData.data.vact);

      // Model 438
      // const pm25 = getCharacteristicValue(deviceData.data.pm25);
      const pm10 = getCharacteristicValue(deviceData.data.pm10);
      const va10 = getCharacteristicValue(deviceData.data.va10);
      // const p25r = getCharacteristicValue(deviceData.data.p25r);
      // const p10r = getCharacteristicValue(deviceData.data.p10r);

      const noxl = getCharacteristicValue(deviceData.data.noxl);
      const nitrogenDioxideDensity = getNumericValue(noxl);

      /*
        Air quality
        1-3 = Low
        4-6 = Moderate
        7-9 = High
      */
      // eslint-disable-next-line radix
      const dustValue = Number.parseInt(pact || pm10);
      // eslint-disable-next-line radix
      const vocValue = Number.parseInt(vact || va10);
      let airQuality = 0;
      // eslint-disable-next-line no-restricted-globals
      if (isNaN(dustValue) && isNaN(vocValue)) {
        airQuality = Math.min(
          Math.max(Math.floor(((dustValue + vocValue) / 2) * 1.0), 1),
          5,
        );
      }

      this.logger.trace(
        `${this._traceStack()} - Disconnect from device: ${
          device.friendlyName
        } (${dysonUserName})`,
      );
      await mqttClient.end();
      mqttClient = null;

      const dataValues = [
        new Date(),
        process.env.ENVIRONMENT,
        device.friendlyName,
        airQuality,
        temperature,
        humidity,
        nitrogenDioxideDensity,
      ];

      await saveDeviceData.call(this, dataValues); // Save data to data store
    }
    return true;
  });
}

async function getDysonCloudData() {
  this.logger.trace(
    `${this._traceStack()} - Get connection data from Dyson cloud`,
  );

  const url =
    'https://appapi.cp.dyson.com/v1/userregistration/authenticate?country=GB';

  const DysonUserName = await this._getVaultSecret('DysonUserName');
  const DysonPassword = await this._getVaultSecret('DysonPassword');
  const body = {
    Email: DysonUserName,
    Password: DysonPassword,
  };
  const results = await this._callAPIServicePut(url, body);
  if (results instanceof Error) {
    this.logger.error(`${this._traceStack()} - ${results.message}`);
    return results;
  }
  this.DysonCloud = results;
  return true;
}

async function getDysonCloudDevices() {
  this.logger.trace(`${this._traceStack()} - Get devices from Dyson cloud`);

  // Get devices
  const header = {
    Authorization: `Basic ${Buffer.from(
      `${this.DysonCloud.Account}:${this.DysonCloud.Password}`,
    ).toString('base64')}`,
  };
  const url = 'https://appapi.cp.dyson.com/v2/provisioningservice/manifest';
  const results = await this._callAPIServiceGet(url, header);
  if (results instanceof Error) {
    this.logger.error(`${this._traceStack()} - ${results.message}`);
    return results;
  }
  this.DysonCloudDevices = results;
  return true;
}

async function getDysonDeviceIP() {
  this.logger.trace(`${this._traceStack()} - Update devices with IP`);

  let deviceError = 0;
  // eslint-disable-next-line no-restricted-syntax
  for await (const device of this.DysonCloudDevices) {
    try {
      const exisitingDevice =
        this.devices.filter((d) => d.Serial === device.Serial).length > 0;
      if (!exisitingDevice) {
        this.logger.debug(
          `${this._traceStack()} - New device, getting IP for: ${
            device.Name
          } (${device.Serial})`,
        );
        // eslint-disable-next-line no-await-in-loop
        const dysonDevice = await this._bonjourScan(device.Serial);
        dysonDevice.Serial = device.Serial;
        dysonDevice.LocalCredentials = device.LocalCredentials;
        dysonDevice.friendlyName = device.Name;
        this.devices.push(dysonDevice);
      } else {
        this.logger.debug(
          `${this._traceStack()} - Existing device, using cached IP for: ${
            device.Name
          }`,
        );
      }
    } catch (err) {
      this.logger.error(`${this._traceStack()} - ${err.message}`);
      deviceError += 1;
    }
  }
  if (deviceError > 0) getDysonDeviceIP.call(this); // Not able to find all devices, re-scan now
}

async function _getPureCoolData() {
  this.logger.trace(`${this._traceStack()} - Get PureCool device data`);
  try {
    if (!this.DysonCloud) {
      const err = await getDysonCloudData.call(this);
      if (err instanceof Error) {
        setTimeout(() => _getPureCoolData.call(this), poolingInterval); // Wait normal intival before re-try
        return;
      }
    } else {
      this.logger.trace(
        `${this._traceStack()} - Using cached Dyson cloud data`,
      );
    }

    if (!this.DysonCloudDevices) {
      const err = await getDysonCloudDevices.call(this);
      if (err instanceof Error) {
        setTimeout(() => _getPureCoolData.call(this), poolingInterval); // Wait normal intival before re-try
        return;
      }
    } else {
      this.logger.trace(
        `${this._traceStack()} - Using cached Dyson cloud device data`,
      );
    }

    if (this.devices.length !== this.DysonCloudDevices.length)
      await getDysonDeviceIP.call(this);

    // eslint-disable-next-line no-restricted-syntax
    for await (const device of this.devices) {
      await processData.call(this, device);
    }
    setTimeout(() => _getPureCoolData.call(this), poolingInterval); // Wait normal intival before polling
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  }
}

module.exports = {
  _getPureCoolData,
};
