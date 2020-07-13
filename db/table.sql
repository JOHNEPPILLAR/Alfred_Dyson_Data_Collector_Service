CREATE TABLE dyson_purecool (
  time            TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  sender          TEXT              NOT NULL,
  location        TEXT              NOT NULL,
  air             DOUBLE PRECISION  NULL,
  temperature     DOUBLE PRECISION  NULL,
  humidity        DOUBLE PRECISION  NULL,
  nitrogen        DOUBLE PRECISION  NULL
)

SELECT create_hypertable('dyson_purecool', 'time');
