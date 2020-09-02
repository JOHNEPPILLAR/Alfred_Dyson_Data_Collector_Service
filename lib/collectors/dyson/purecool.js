/**
 * Import external libraries
 */
const mqtt = require('mqtt');
const crypto = require('crypto');

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

async function processData(device, dysonIP) {
  const dysonUserName = device.Serial;
  const model = device.Name === 'Office' ? 455 : 438;

  let mqttClient;

  this.logger.trace(
    `${this._traceStack()} - Processing device: ${device.Name} (${
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
        device.Name
      } on ${dysonIP}`,
    );
    mqttClient = await mqtt.connect(`mqtt://${dysonIP}`, mqttClientOptions);
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  }

  mqttClient.on('error', (err) => {
    this.logger.error(`${this._traceStack()} - ${err.message}`);

    if (err.message.includes('ECONNREFUSED')) {
      this.logger.error(`${this._traceStack()} - ${err.message}`);
      mqttClient.end(); // Force end due to connection error
    }
  });

  mqttClient.on('connect', async () => {
    this.logger.trace(
      `${this._traceStack()} - Connected to device: ${dysonUserName}`,
    );
    const statusSubscribeTopic = `${model}/${dysonUserName}/status/current`;
    await mqttClient.subscribe(statusSubscribeTopic);

    this.logger.trace(
      `${this._traceStack()} - Force state update from device: ${dysonUserName}`,
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
        `${this._traceStack()} - Got sensor data from device: ${dysonUserName}`,
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

      const dataValues = [
        new Date(),
        process.env.ENVIRONMENT,
        device.Name,
        airQuality,
        temperature,
        humidity,
        nitrogenDioxideDensity,
      ];

      await saveDeviceData.call(this, dataValues); // Save data to data store

      this.logger.trace(
        `${this._traceStack()} - Disconnect from device: ${dysonUserName}`,
      );
      await mqttClient.end();
    }
    return true;
  });
}

async function _getPureCoolData() {
  try {
    const poolingInterval = 5 * 60 * 1000; // 5 minutes

    // Signin to Dyson cloud
    let url =
      'https://appapi.cp.dyson.com/v1/userregistration/authenticate?country=GB';

    const DysonUserName = await this._getVaultSecret('DysonUserName');
    const DysonPassword = await this._getVaultSecret('DysonPassword');
    const body = {
      Email: DysonUserName,
      Password: DysonPassword,
    };
    let results = await this._callAPIServicePut(url, body);
    if (results instanceof Error) {
      this.logger.error(`${this._traceStack()} - ${results.message}`);
      return;
    }

    // Get devices
    const header = {
      Authorization: `Basic ${Buffer.from(
        `${results.Account}:${results.Password}`,
      ).toString('base64')}`,
    };
    url = 'https://appapi.cp.dyson.com/v2/provisioningservice/manifest';
    results = await this._callAPIServiceGet(url, header);
    if (results instanceof Error) {
      this.logger.error(`${this._traceStack()} - ${results.message}`);
      return;
    }

    // Process devices
    this.logger.trace(`${this._traceStack()} - Process devices`);

    let deviceError = 0;
    // eslint-disable-next-line no-restricted-syntax
    for await (const device of results) {
      this.logger.debug(
        `${this._traceStack()} - Scanning network for Dyson device: ${
          device.Name
        }`,
      );

      let dysonDevice;
      try {
        // eslint-disable-next-line no-await-in-loop
        dysonDevice = await this._bonjourScan(device.Serial);
        // eslint-disable-next-line no-await-in-loop
        await processData.call(this, device, dysonDevice.addresses[0]);
      } catch (err) {
        this.logger.error(`${this._traceStack()} - ${err.message}`);
        deviceError += 1;
      }
    }

    if (deviceError > 0) {
      _getPureCoolData.call(this); // Not able to find all devices, re-scan now
    } else {
      setTimeout(() => {
        _getPureCoolData.call(this);
      }, poolingInterval); // Wait normal intival before re-scan
    }
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  }
}

module.exports = {
  _getPureCoolData,
};
