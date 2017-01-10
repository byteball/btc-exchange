/*jslint node: true */
'use strict';
var bitcoin = require('bitcoin');

var client = new bitcoin.Client({
	host: 'localhost',
	port: 18332,
	user: 'bitcoin',
	pass: 'local321',
	timeout: 30000
});

module.exports = client;
