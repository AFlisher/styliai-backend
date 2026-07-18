const geoip = require("geoip-lite");

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * Looks up the country for an IP address. Stateless: performs a local
 * lookup only and does not persist or log the IP or the result.
 * Returns null if the IP is private/local or not found in the dataset.
 */
function getCountryFromIp(ip) {
  if (!ip) return null;

  const geo = geoip.lookup(ip);
  if (!geo || !geo.country) return null;

  const countryCode = geo.country;
  let countryName = null;
  try {
    countryName = regionNames.of(countryCode) || null;
  } catch {
    countryName = null;
  }

  return { countryCode, countryName };
}

module.exports = { getCountryFromIp };
