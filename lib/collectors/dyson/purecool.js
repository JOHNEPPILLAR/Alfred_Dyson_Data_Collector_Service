/* eslint-disable no-nested-ternary */

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

/**
 * Process device data
 */
async function processData(device) {
  let mqttClient;
  let hasAdvancedAirQualitySensors = false;
  let nitrogenDioxideDensity = null;

  if (device.ProductType === '438') hasAdvancedAirQualitySensors = true;

  this.logger.trace(
    `${this._traceStack()} - Processing device: ${device.Name} (${
      device.Serial
    })`,
  );

  try {
    this.logger.trace(`${this._traceStack()} - Decrypt password`);
    crypto.randomBytes(32).toString('hex');
    const ENC_KEY = Buffer.from([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20',
      '21',
      '22',
      '23',
      '24',
      '25',
      '26',
      '27',
      '28',
      '29',
      '30',
      '31',
      '32',
    ]);
    const IV = Buffer.from([
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
    ]);
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, IV);
    let decrypted = decipher.update(device.LocalCredentials, 'base64', 'utf-8');
    decrypted += decipher.final('utf-8');
    const json = JSON.parse(decrypted);
    const dysonPassword = json.apPasswordHash;

    const mqttClientOptions = {
      username: device.Serial,
      password: dysonPassword,
      protocolVersion: 3,
      protocolId: 'MQIsdp',
    };

    this.logger.trace(
      `${this._traceStack()} - Connecting to Dyson device: ${device.Name} on ${
        device.ip
      }`,
    );

    mqttClient = mqtt.connect(`mqtt://${device.ip}`, mqttClientOptions);
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

      // Parses the air quality sensor data
      let airQuality = 0;
      let pm25 = 0;
      let pm10 = 0;
      let va10 = 0;
      let noxl = 0;
      let p = 0;
      let v = 0;
      if (hasAdvancedAirQualitySensors) {
        pm25 =
          deviceData.data.pm25 === 'INIT'
            ? 0
            : Number.parseInt(deviceData.data.pm25, 10);
        pm10 =
          deviceData.data.pm10 === 'INIT'
            ? 0
            : Number.parseInt(deviceData.data.pm10, 10);
        va10 =
          deviceData.data.va10 === 'INIT'
            ? 0
            : Number.parseInt(deviceData.data.va10, 10);
        noxl =
          deviceData.data.noxl === 'INIT'
            ? 0
            : Number.parseInt(deviceData.data.noxl, 10);
      } else {
        p = Number.parseInt(deviceData.data.pact, 10);
        v = Number.parseInt(deviceData.data.vact, 10);
      }

      // Maps the values of the sensors to the relative values
      // described in the app
      // (1 - 5 => Good, Medium, Bad, Very Bad, Extremely Bad)
      const pm25Quality =
        pm25 <= 35 ? 1 : pm25 <= 53 ? 2 : pm25 <= 70 ? 3 : pm25 <= 150 ? 4 : 5;
      const pm10Quality =
        pm10 <= 50 ? 1 : pm10 <= 75 ? 2 : pm10 <= 100 ? 3 : pm10 <= 350 ? 4 : 5;

      // Maps the VOC values to a self-created scale
      // (as described values in the app don't fit)
      const va10Quality =
        va10 * 0.125 <= 3
          ? 1
          : va10 * 0.125 <= 6
          ? 2
          : va10 * 0.125 <= 8
          ? 3
          : 4;

      // Maps the NO2 value to a self-created scale
      const noxlQuality =
        noxl <= 30 ? 1 : noxl <= 60 ? 2 : noxl <= 80 ? 3 : noxl <= 90 ? 4 : 5;

      // Maps the values of the sensors to the relative values,
      // these operations are copied from the newer devices as
      // the app does not specify the correct values
      const pQuality = p <= 2 ? 1 : p <= 4 ? 2 : p <= 7 ? 3 : p <= 9 ? 4 : 5;
      const vQuality =
        v * 0.125 <= 3 ? 1 : v * 0.125 <= 6 ? 2 : v * 0.125 <= 8 ? 3 : 4;

      // Sets the sensor data for air quality (the poorest sensor result wins)
      if (hasAdvancedAirQualitySensors) {
        airQuality = Math.max(
          pm25Quality,
          pm10Quality,
          va10Quality,
          noxlQuality,
        );
        nitrogenDioxideDensity = noxl;
      } else {
        airQuality = Math.max(pQuality, vQuality);
      }

      // Temperature
      const temperature =
        Number.parseInt(deviceData.data.tact, 10) / 10.0 - 273.0;

      // Humidity
      const humidity = Number.parseInt(deviceData.data.hact, 10);

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
