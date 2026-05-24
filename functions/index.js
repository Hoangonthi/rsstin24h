const {onRequest} = require("firebase-functions/v2/https");

exports.healthCheck = onRequest((req, res) => {
  res.send("RSS Firebase Functions is running");
});
