/**
 * Import external libraries
 */
const mqtt = require('mqtt');
const serviceHelper = require('alfred-helper');

const poolingInterval = 5 * 60 * 1000; // 5 minutes

/**
 * Save data to data store
 */
async function saveDeviceData(SQLValues) {
  try {
    const SQL = 'INSERT INTO dyson_purecool("time", sender, location, air, temperature, humidity, nitrogen) VALUES ($1, $2, $3, $4, $5, $6, $7)';
    const dbConnection = await serviceHelper.connectToDB('dyson');
    serviceHelper.log('trace', 'Save sensor values');
    const results = await dbConnection.query(
      SQL,
      SQLValues,
    );
    serviceHelper.log(
      'trace',
      'Release the data store connection back to the pool',
    );
    await dbConnection.end(); // Close data store connection

    if (results.rowCount !== 1) {
      serviceHelper.log(
        'error',
        `Failed to insert data for device ${SQLValues[2]}`,
      );
      return;
    }
    serviceHelper.log(
      'info',
      `Saved data for device ${SQLValues[2]}`,
    );
  } catch (err) {
    serviceHelper.log(
      'error',
      err.message,
    );
  }
}

function getCharacteristicValue(rawValue) {
  if (!rawValue) return 0;
  const integerValue = Number.parseInt(rawValue, 10);

  // Reduces the scale from 0-100 to 0-10 as used in the Dyson app
  // integerValue = Math.floor(integerValue / 10);

  // if (integerValue <= 3) return 2; // Characteristic.AirQuality.GOOD
  // if (integerValue <= 6) return 3; // Characteristic.AirQuality.FAIR
  // if (integerValue <= 8) return 4; // Characteristic.AirQuality.INFERIOR
  // return 5; // Characteristic.AirQuality.POOR
  return integerValue;
}

// Converts the raw value into an integer
function getNumericValue(rawValue) {
  if (!rawValue) return 0;
  return Number.parseInt(rawValue, 10);
}

exports.processPureCoolData = async function processPureCoolData() {
  const DysonUserName = await serviceHelper.vaultSecret(
    process.env.ENVIRONMENT,
    'DysonUserName',
  );
  const DysonPassword = await serviceHelper.vaultSecret(
    process.env.ENVIRONMENT,
    'DysonPassword',
  );
  const dysonOfficeIP = await serviceHelper.vaultSecret(
    process.env.ENVIRONMENT,
    'DysonOfficeIP',
  );
  if (DysonUserName instanceof Error
    || DysonPassword instanceof Error
    || dysonOfficeIP instanceof Error) {
    serviceHelper.log(
      'error',
      'Not able to get secret (Dyson info) from vault',
    );
    return;
  }
  const mqttClientOptions = {
    username: DysonUserName,
    password: DysonPassword,
    clientId: 'alfred_dynson',
  };

  serviceHelper.log(
    'trace',
    'Connecting to Dyson device',
  );
  const mqttClient = await mqtt.connect(
    `mqtt://${dysonOfficeIP}`,
    mqttClientOptions,
  );

  mqttClient.on('error', (err) => serviceHelper.log('error', err.message));
  mqttClient.on('connect', async () => {
    serviceHelper.log(
      'trace',
      `Connected to device: ${DysonUserName}`,
    );
    const statusSubscribeTopic = `455/${DysonUserName}/status/current`;
    await mqttClient.subscribe(statusSubscribeTopic);

    serviceHelper.log(
      'trace',
      `Force state update from device: ${DysonUserName}`,
    );
    const commandTopic = `455/${DysonUserName}/command`;
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
      serviceHelper.log(
        'trace',
        `Got sensor data from device: ${DysonUserName}`,
      );

      /*
        Air quality
        1-3 = Low
        4-6 = Moderate
        7-9 = High
      */

      const dataValues = [
        new Date(),
        process.env.ENVIRONMENT,
        'Bedroom',
        Math.max(
          getCharacteristicValue(deviceData.data.pm25),
          getCharacteristicValue(deviceData.data.pm10),
          getCharacteristicValue(deviceData.data.va10),
          getCharacteristicValue(deviceData.data.noxl),
          getCharacteristicValue(deviceData.data.pact),
          getCharacteristicValue(deviceData.data.vact),
        ), // Air Quality
        Number.parseFloat(deviceData.data.tact) / 10 - 273, // Temperature
        // eslint-disable-next-line radix
        Number.parseInt(deviceData.data.hact), // Humidity
        getNumericValue(deviceData.data.noxl), // Nitrogen Dioxide Density
      ];

      await saveDeviceData(dataValues); // Save data to data store

      serviceHelper.log(
        'trace',
        `Disconnect from device: ${DysonUserName}`,
      );
      await mqttClient.end();
    }
    return true;
  });

  setTimeout(async () => {
    await mqttClient.end();
    await processPureCoolData();
  }, poolingInterval); // Wait then run function again
};
