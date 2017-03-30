/*jslint node: true */
'use strict';
var bitcoin = require('bitcoin');
var constants = require('byteballcore/constants.js');

var bTestnet = constants.version.match(/t$/);

var client = new bitcoin.Client({
	host: 'localhost',
	port: bTestnet ? 18332 : 8332,
	user: 'bitcoin',
	pass: 'local321',
	timeout: 60000
});

module.exports = client;
