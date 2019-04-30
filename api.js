/*jslint node: true */
'use strict';

var eventBus = require('ocore/event_bus.js');
var validationUtils = require("ocore/validation_utils.js");
var book = require("./book.js");
var db = require('ocore/db.js');

const rateLimitationWindowPeriodInSec = 30;
const maxHitsPerPeriod = 6;
const noWarningThreshold = 2;

const assocErrors = {
	0: "too many requests",
	1: "you're not an alias",
	2: "object has a key not allowed",
	3: "command should be a string",
	4: "price should be a number",
	5: "tag should be a string",
	6: "time_limit should be an integer",
	7: "no price set for buy or sell command",
	8: "time limit expired"
}

var assocHitsByAddress = {};

setInterval(function(){
	assocHitsByAddress = {};
}, rateLimitationWindowPeriodInSec * 1000);

eventBus.on('object', function(from_alias_address, receivedObject){

	if (!assocHitsByAddress[from_alias_address])
		assocHitsByAddress[from_alias_address] = 0;
	assocHitsByAddress[from_alias_address]++;

	//don't do anything if hits rate is excessive
	if (assocHitsByAddress[from_alias_address] > (maxHitsPerPeriod + noWarningThreshold))
		return;

	//send a warning when hits rate is just over the limit
	var device = require('ocore/device.js');
	if (assocHitsByAddress[from_alias_address] > maxHitsPerPeriod)
		return device.sendMessageToDevice(from_alias_address, 'object', {error_code: 0, error: assocErrors[0]});

	var error_code = isReceivedObjectInvalid(receivedObject);
	if (error_code)
		return  device.sendMessageToDevice(from_alias_address, 'object', {error_code: error_code, error: assocErrors[error_code]});

	db.query("SELECT device_address FROM aliases WHERE alias=?",[from_alias_address], function(rows){
		if (rows[0])
			treatReceivedObject(from_alias_address, rows[0].device_address, receivedObject);
		else
			return device.sendMessageToDevice(from_alias_address, 'object', {error_code: 1, error: assocErrors[1]});
	});

});


function isReceivedObjectInvalid(receivedObject){

	if (validationUtils.hasFieldsExcept(receivedObject,["command", "price", "tag", "time_limit"]))
		return 2;

	if (!validationUtils.isNonemptyString(receivedObject.command))
		return 3;

	if (receivedObject.price && typeof receivedObject.price != "number" && receivedObject.price > 0)
		return 4;
	
	if (!validationUtils.isNonemptyString(receivedObject.tag))
		return 5;

	if (!validationUtils.isPositiveInteger(receivedObject.time_limit))
		return 6;

	if (receivedObject.time_limit < new Date() / 1000)
		return 8;

	return false;

}


function treatReceivedObject(from_alias_address, from_address, receivedObject){
	var device = require('ocore/device.js');

	if (receivedObject.command === "buy" || receivedObject.command === "sell") {
		if (!receivedObject.price)
			return device.sendMessageToDevice(from_alias_address, 'object', {error_code: 7, error: assocErrors[7]});
		book.updateCurrentPrice(from_address, receivedObject.command, receivedObject.price.toFixed(9), function(){
			return device.sendMessageToDevice(from_alias_address, 'object', {response: "accepted", tag: receivedObject.tag});
		})
	}

	if (receivedObject.command === "orders") {
		book.getOrders(from_address, function(orders){
			return device.sendMessageToDevice(from_alias_address, 'object', {response: orders, tag: receivedObject.tag});
		});
	}

	if (receivedObject.command === "book") {
		book.getOrders(null, function(book){
			return device.sendMessageToDevice(from_alias_address, 'object', {response: book, tag: receivedObject.tag});
		});
	}

}


function notifyPayment(device_address, type, amount, txid){

	db.query("SELECT alias FROM aliases INNER JOIN correspondent_devices ON correspondent_devices.device_address=aliases.alias WHERE aliases.device_address=?", [device_address], function(rows){
		if (rows[0]){
			var device = require('ocore/device.js');
			return device.sendMessageToDevice(rows[0].alias, 'object', {
				event: "transaction", 
				type: type, 
				amount: amount, 
				txid: txid
			});
		}
	});

}

function setAlias(from_address, alias_address, handle){
	db.query("REPLACE INTO aliases (device_address,alias) VALUES (?,?)", [from_address,alias_address], handle);
}

function removeAlias(from_address, handle){
	db.query("DELETE FROM aliases WHERE device_address=?", [from_address], handle);
}


exports.setAlias = setAlias;
exports.removeAlias = removeAlias;
exports.notifyPayment = notifyPayment;