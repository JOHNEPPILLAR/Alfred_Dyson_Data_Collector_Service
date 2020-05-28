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

  return integerValue;
}

// Converts the raw value into an integer
function getNumericValue(rawValue) {
  if (!rawValue) return 0;
  return Number.parseInt(rawValue, 10);
}

async function processPureCoolData(room) {
  const DysonUserName = await serviceHelper.vaultSecret(
    process.env.ENVIRONMENT,
    `Dyson${room}UserName`,
  );
  const DysonPassword = await serviceHelper.vaultSecret(
    process.env.ENVIRONMENT,
    `Dyson${room}Password`,
  );

  const dysonIP = await serviceHelper.vaultSecret(
    process.env.ENVIRONMENT,
    `Dyson${room}IP`,
  );
  if (DysonUserName instanceof Error
    || DysonPassword instanceof Error
    || dysonIP instanceof Error) {
    serviceHelper.log(
      'error',
      'Not able to get secret (Dyson info) from vault',
    );
    return;
  }

  const model = room === 'Office' ? 455 : 438;

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
    `mqtt://${dysonIP}`,
    mqttClientOptions,
  );

  mqttClient.on('error', (err) => serviceHelper.log('error', err.message));
  mqttClient.on('connect', async () => {
    serviceHelper.log(
      'trace',
      `Connected to device: ${DysonUserName}`,
    );
    const statusSubscribeTopic = `${model}/${DysonUserName}/status/current`;
    await mqttClient.subscribe(statusSubscribeTopic);

    serviceHelper.log(
      'trace',
      `Force state update from device: ${DysonUserName}`,
    );
    const commandTopic = `${model}/${DysonUserName}/command`;
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
      const pm25 = getCharacteristicValue(deviceData.data.pm25);
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
      const airQuality = Math.max(
        pm25,
        pm10,
        va10,
        noxl,
        pact,
        vact,
      );

      const dataValues = [
        new Date(),
        process.env.ENVIRONMENT,
        room,
        airQuality,
        temperature,
        humidity,
        nitrogenDioxideDensity,
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
}

exports.getPureCoolData = async function getPureCoolData() {
  await processPureCoolData('Office');
  await processPureCoolData('Bedroom');
  setTimeout(async () => {
    getPureCoolData();
  }, poolingInterval); // Wait then run function again
};
