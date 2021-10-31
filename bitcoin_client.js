/*jslint node: true */
'use strict';
var Client = require('bitcoin-core');

var client = new Client({
	host: 'localhost',
	port: process.env.testnet ? 18332 : 8332,
	username: 'bitcoin',
	password: 'local321',
	timeout: 60000
});

module.exports = client;
