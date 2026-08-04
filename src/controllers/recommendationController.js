const recommendationService = require("../services/recommendationService");
const {
  clampLimit,
  RECOMMENDATION_LIMIT_DEFAULT,
  RECOMMENDATION_LIMIT_MAX,
} = require("../utils/pagination");

async function getSimilarStyles(req, res) {
  try {
    const { id } = req.params;

    // SEC-9.3: was `Number(req.query.limit) || 10` with no upper bound, so
    // `?limit=99999999` reached the service and became `.slice(0, 1e9)`. The
    // candidate set is small enough that this only ever returned the whole
    // catalog - which is why the audit rates it negligible today and a
    // validation smell rather than a hole. Clamping it is what stops that
    // staying true only by accident as the catalog grows.
    //
    // Note the old expression also mapped `?limit=0` to 10 (0 is falsy),
    // meaning a caller could never actually request zero results. clampLimit
    // preserves the same outcome by flooring at 1, so no working request
    // changes behaviour.
    const limit = clampLimit(req.query.limit, {
      def: RECOMMENDATION_LIMIT_DEFAULT,
      max: RECOMMENDATION_LIMIT_MAX,
    });

    const styles = await recommendationService.getSimilarStyles({ styleId: id, limit });

    if (styles === null) {
      return res.status(404).json({
        message: "Style not found.",
      });
    }

    res.json(styles);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed to load similar styles.",
    });
  }
}

module.exports = {
  getSimilarStyles,
};
