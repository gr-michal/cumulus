var aws_access_id = "AKIAIOSFODNN7EXXXPLE";
var aws_access_password = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXMPLEKEEY";

module.exports.userEval = function (req, res) {
  eval(req.body.evil);
}
