require('dotenv').config();

/**
 * Configurable water flow rate (Liters per minute).
 * Uses environment variable WATER_FLOW_RATE_LPM; defaults to 15 L/min.
 */
const WATER_FLOW_RATE_LPM = (() => {
  const envVal = process.env.WATER_FLOW_RATE_LPM;
  const parsed = parseFloat(envVal);
  return (!isNaN(parsed) && parsed > 0) ? parsed : 15;
})();

module.exports = {
  WATER_FLOW_RATE_LPM
};
