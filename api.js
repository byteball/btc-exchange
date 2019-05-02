/*jslint node: true */
'use strict';

var eventBus = require('ocore/event_bus.js');
var validationUtils = require("ocore/validation_utils.js");
var book = require("./book.js");
var db = require('ocore/db.js');

const rateLimitationWindowPeriodInSec = 30;
const maxHitsPerPeriod = 6;
const noWarningThreshold = 2;

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
		return device.sendMessageToDevice(from_alias_address, 'object', {error_code: 0, error: "too many requests"});

	var error = isReceivedObjectInvalid(receivedObject);
	if (error)
		return  device.sendMessageToDevice(from_alias_address, 'object', error);

	db.query("SELECT device_address FROM aliases WHERE alias=?",[from_alias_address], function(rows){
		if (rows[0])
			treatReceivedObject(from_alias_address, rows[0].device_address, receivedObject);
		else
			return device.sendMessageToDevice(from_alias_address, 'object', {error_code: 1, error: "you're not an alias"});
	});

});


function isReceivedObjectInvalid(receivedObject){

	if (validationUtils.hasFieldsExcept(receivedObject,["command", "price", "tag", "time_limit"]))
		return {error_code: 2, error: "object has a key not allowed"};

	if (!validationUtils.isNonemptyString(receivedObject.command))
		return {error_code: 3, error: "command should be a string"};

	if (receivedObject.price && typeof receivedObject.price != "number" && receivedObject.price > 0)
		return {error_code: 4, error: "price should be a number"};
	
	if (!validationUtils.isNonemptyString(receivedObject.tag))
		return {error_code: 5, error: "tag should be a string"};

	if (!validationUtils.isPositiveInteger(receivedObject.time_limit))
		return {error_code: 6, error: "time_limit should be an integer"};

	if (receivedObject.time_limit < new Date() / 1000)
		return {error_code: 8, error: "time limit expired"};

	return false;

}


function treatReceivedObject(from_alias_address, from_address, receivedObject){
	var device = require('ocore/device.js');

	if (receivedObject.command === "buy" || receivedObject.command === "sell") {
		if (!receivedObject.price)
			return device.sendMessageToDevice(from_alias_address, 'object', {error_code: 7, error: "no price set for buy or sell command"});
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
	db.query("SELECT 1 FROM aliases WHERE alias=? AND device_address!=?", [alias_address, from_address], function(rows){
		if (rows[0])
			return handle(alias_address + " is already used as alias");
		else
			db.query("REPLACE INTO aliases (device_address,alias) VALUES (?,?)", [from_address,alias_address], function(){
				return handle();	
			});
	});
}

function removeAlias(from_address, handle){
	db.query("DELETE FROM aliases WHERE device_address=?", [from_address], handle);
}


exports.setAlias = setAlias;
exports.removeAlias = removeAlias;
exports.notifyPayment = notifyPayment;