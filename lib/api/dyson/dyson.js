/**
 * @type get
 * @path /sensors
 */

async function _sensors(req, res, next) {
  this.logger.debug(
    `${this._traceStack()} - Display Dyson PureCool data API called`,
  );

  let durationTitle;
  let timeBucket;
  let interval;

  const { durationSpan } = req.query;
  try {
    switch (durationSpan) {
      case 'year':
        timeBucket = '6 hours';
        interval = '1 year';
        durationTitle = 'Last year';
        break;
      case 'month':
        timeBucket = '3 hours';
        interval = '1 month';
        durationTitle = 'Last month';
        break;
      case 'week':
        timeBucket = '1 hour';
        interval = '1 week';
        durationTitle = 'Last week';
        break;
      case 'day':
        timeBucket = '30 minutes';
        interval = '1 day';
        durationTitle = 'Last 24 hours';
        break;
      default:
        // Hour
        timeBucket = '1 minute';
        interval = '1 hour';
        durationTitle = 'Last hour';
        break;
    }

    const sql = `SELECT time_bucket('${timeBucket}', time) AS timeofday, last(location, time) as location, avg(temperature) as temperature, avg(humidity) as humidity, min(air) as air_quality, avg(nitrogen) as nitrogen FROM dyson_purecool WHERE time > NOW() - interval '${interval}' GROUP BY timeofday ORDER BY timeofday DESC`;
    this.logger.trace(
      `${this._traceStack()} - Connect to data store connection pool`,
    );
    const dbConnection = await this._connectToDB('dyson');
    this.logger.trace(`${this._traceStack()} - Get sensor values`);
    const results = await dbConnection.query(sql);
    this.logger.trace(
      `${this._traceStack()} - Release the data store connection back to the pool`,
    );
    await dbConnection.end(); // Close data store connection

    if (results.rowCount === 0) {
      this.logger.trace(`${this._traceStack()} - No data to return`);
      this._sendResponse(res, next, 200, []);
      return [];
    }
    results.DurationTitle = durationTitle;
    results.rows.reverse();
    this._sendResponse(res, next, 200, results.rows);
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
    if (typeof res !== 'undefined' && res !== null) {
      this._sendResponse(res, next, 500, err);
    }
    return err;
  }
  return true;
}

/**
 * @type get
 * @path /current
 */
async function _current(req, res, next) {
  this.logger.debug(
    `${this._traceStack()} - Display Dyson PureCool latest readings API called`,
  );

  try {
    const sql =
      "SELECT last(location, time) as location, last(air, time) as air, last(temperature, time) as temperature, last(humidity, time) as humidity, last(nitrogen, time) as nitrogen FROM dyson_purecool WHERE time > NOW() - interval '1 hour' GROUP BY location";
    this.logger.trace(
      `${this._traceStack()} - Connect to data store connection pool`,
    );
    const dbConnection = await this._connectToDB('dyson');
    this.logger.trace(`${this._traceStack()} - Get sensor values`);
    const results = await dbConnection.query(sql);
    this.logger.trace(
      `${this._traceStack()} - Release the data store connection back to the pool`,
    );
    await dbConnection.end(); // Close data store connection

    if (results.rowCount === 0) {
      this.logger.trace(
        `${this._traceStack()} - No data exists in the last hour`,
      );
      this._sendResponse(res, next, 200, []);
      return;
    }

    const returnData = results.rows;
    this._sendResponse(res, next, 200, returnData);
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
    if (typeof res !== 'undefined' && res !== null) {
      this._sendResponse(res, next, 500, err);
    }
  }
}

module.exports = {
  _sensors,
  _current,
};
