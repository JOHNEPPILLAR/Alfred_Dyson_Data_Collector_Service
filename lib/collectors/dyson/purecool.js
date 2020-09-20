/**
 * Import external libraries
 */
const mqtt = require('mqtt');
const crypto = require('crypto');

const poolingInterval = 5 * 60 * 1000; // 5 minutes

/**
 * Save data to data store
 */
async function saveDeviceData(device) {
  let dbConnection;
  this.logger.trace(
    `${this._traceStack()} - Saving data: ${device.name} (${device.device})`,
  );

  try {
    dbConnection = await this._connectToDB();
    this.logger.trace(`${this._traceStack()} - Insert data`);
    const results = await dbConnection
      .db(this.namespace)
      .collection(this.namespace)
      .insertOne(device);

    // Send data back to caler
    if (results.insertedCount === 1)
      this.logger.info(`Saved data: ${device.name} (${device.device})`);
    else
      this.logger.error(
        `${this._traceStack()} - Failed to save data: ${device.name} (${
          device.device
        })`,
      );
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  } finally {
    this.logger.trace(`${this._traceStack()} - Close DB connection`);
    await dbConnection.close();
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

/**
 * Process device data
 */
async function processData(device) {
  let mqttClient;

  this.logger.trace(
    `${this._traceStack()} - Processing device: ${device.Name} (${
      device.Serial
    })`,
  );

  try {
    this.logger.trace(`${this._traceStack()} - Decrypt password`);
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
      username: device.Serial,
      password: dysonPassword,
      //  clientId: 'alfred_dynson',
    };

    if (device.ProductType === 438) {
      mqttClientOptions.protocolVersion = 3;
      mqttClientOptions.protocolId = 'MQIsdp';
    }

    this.logger.trace(
      `${this._traceStack()} - Connecting to Dyson device: ${device.Name} on ${
        device.ip
      }`,
    );
    mqttClient = await mqtt.connect(`mqtt://${device.ip}`, mqttClientOptions);
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  }

  mqttClient.on('error', (err) => {
    if (
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('Identifier rejected') ||
      err.message.includes('getaddrinfo ENOTFOUND undefined') ||
      err.message.includes('Connection refused')
    ) {
      this.logger.error(
        `${this._traceStack()} - Connection error: ${device.Name} (${
          device.Serial
        }): ${err.message}`,
      );
      mqttClient.end();
      mqttClient = null;
    } else {
      this.logger.error(`${this._traceStack()} - ${err.message}`);
    }
  });

  mqttClient.on('connect', async () => {
    this.logger.trace(
      `${this._traceStack()} - Connected to device: ${device.Name} (${
        device.Serial
      })`,
    );
    const statusSubscribeTopic = `${device.ProductType}/${device.Serial}/status/current`;
    await mqttClient.subscribe(statusSubscribeTopic);

    this.logger.trace(
      `${this._traceStack()} - Force state update for device: ${device.Name} (${
        device.Serial
      })`,
    );
    const commandTopic = `${device.ProductType}/${device.Serial}/command`;
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
        `${this._traceStack()} - Got sensor data from device: ${device.Name} (${
          device.Serial
        })`,
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
        `${this._traceStack()} - Disconnect from device: ${device.Name} (${
          device.Serial
        })`,
      );
      await mqttClient.end();
      mqttClient = null;

      const dataValues = {
        time: new Date(),
        device: device.Serial,
        name: device.Name,
        airQuality,
        temperature,
        humidity,
        nitrogenDioxideDensity,
      };
      await saveDeviceData.call(this, dataValues); // Save data to data store
    }
    return true;
  });
}

/**
 * Get devices
 */
async function _getDysonDeviceData() {
  this.logger.trace(`${this._traceStack()} - Get Dyson device data`);
  try {
    this.logger.trace(
      `${this._traceStack()} - Get connection data from Dyson cloud`,
    );
    let url =
      'https://appapi.cp.dyson.com/v1/userregistration/authenticate?country=GB';
    const dysonUserName = await this._getVaultSecret('DysonUserName');
    const dysonPassword = await this._getVaultSecret('DysonPassword');
    const body = {
      Email: dysonUserName,
      Password: dysonPassword,
    };
    const dysonCloud = await this._callAPIServicePut(url, body);
    if (dysonCloud instanceof Error) {
      this.logger.error(`${this._traceStack()} - ${dysonCloud.message}`);
      return;
    }

    this.logger.trace(`${this._traceStack()} - Get devices from Dyson cloud`);
    const header = {
      Authorization: `Basic ${Buffer.from(
        `${dysonCloud.Account}:${dysonCloud.Password}`,
      ).toString('base64')}`,
    };
    url = 'https://appapi.cp.dyson.com/v2/provisioningservice/manifest';
    const dysonCloudDevices = await this._callAPIServiceGet(url, header);
    if (dysonCloudDevices instanceof Error) {
      this.logger.error(`${this._traceStack()} - ${dysonCloudDevices.message}`);
      return;
    }
    this.devices = dysonCloudDevices;

    this.logger.trace(`${this._traceStack()} - Assign ip's to devices`);

    await this.devices.map(async (device, index) => {
      this.devices[index].ip = await this._getVaultSecret(device.Serial);
    });

    // eslint-disable-next-line no-restricted-syntax
    for await (const device of this.devices) {
      await processData.call(this, device);
    }

    // Setup intival
    setInterval(async () => {
      // eslint-disable-next-line no-restricted-syntax
      for await (const device of this.devices) {
        await processData.call(this, device);
      }
    }, poolingInterval);
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  }
}

module.exports = {
  _getDysonDeviceData,
};
