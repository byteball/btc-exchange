/*jslint node: true */
'use strict';
var async = require('byteballcore/node_modules/async');
var notifications = require('./notifications.js');
var settlement = require('./settlement.js');
var book = require('./book.js');
var db = require('byteballcore/db.js');
var mutex = require('byteballcore/mutex.js');
var eventBus = require('byteballcore/event_bus.js');

const INSTANT_MARGIN = 0.02;

const MAX_BTC = 0.2;
const MAX_GB = 10;

// from customer's perspective, BTC/GB
const SAFE_BUY_RATE = 0.04;
const SAFE_SELL_RATE = 0.01;

// from customer's perspective, BTC/GB
var buy_rate = SAFE_BUY_RATE;  // higher
var sell_rate = SAFE_SELL_RATE; // lower

function getBuyRate(){
	return buy_rate;
}

function getSellRate(){
	return sell_rate;
}

function handleInstantSellOrder(conn, byte_seller_deposit_id, byte_amount, device_address, onDone){
	var satoshi_amount = book.bytes2satoshis(byte_amount, sell_rate);
	if (satoshi_amount === 0)
		throw Error("satoshi_amount=0");
	conn.query("SELECT * FROM byte_buyer_orders WHERE is_active=1 AND price>=? ORDER BY price DESC, last_update ASC", [sell_rate], function(buyer_rows){
		var total_satoshi = buyer_rows.reduce(function(acc, buyer_order){ return acc + buyer_order.satoshi_amount; }, 0);
		if (total_satoshi < satoshi_amount){
			book.insertSellerOrder(conn, byte_seller_deposit_id, byte_amount, device_address, sell_rate, function(){
				var device = require('byteballcore/device.js');
				device.sendMessageToDevice(device_address, 'text', "Your payment is now final but there's not enough liquidity to complete the exchange.  We'll exchange your bytes as soon as possible.");
			});
			return onDone();
		}
		book.finishSellerDeposit(conn, byte_seller_deposit_id, 0, byte_amount, function(){
			conn.query(
				"INSERT INTO byte_seller_instant_deals (byte_seller_deposit_id, satoshi_amount, byte_amount, price) VALUES (?,?,?,?)", 
				[byte_seller_deposit_id, satoshi_amount, byte_amount, sell_rate],
				function(res){
					var byte_seller_instant_deal_id = res.insertId;
					var remaining_satoshi_amount = satoshi_amount;
					async.eachSeries(
						buyer_rows,
						function(buyer_order, cb){
							var execution_price = buyer_order.price;
							var bFull = (remaining_satoshi_amount >= buyer_order.satoshi_amount); // full execution of the book order
							var bDone = (remaining_satoshi_amount <= buyer_order.satoshi_amount);
							var transacted_satoshis = bFull ? buyer_order.satoshi_amount : remaining_satoshi_amount;
							var transacted_bytes = book.satoshis2bytes(transacted_satoshis, execution_price);
							var buyer_order_props = {
								execution_price: execution_price, 
								transacted_satoshis: transacted_satoshis, 
								transacted_bytes: transacted_bytes, 
								byte_seller_instant_deal_id: byte_seller_instant_deal_id
							};
							book.markBuyerOrderMatched(conn, buyer_order.byte_buyer_order_id, buyer_order_props, function(){
								remaining_satoshi_amount -= transacted_satoshis;
								if (bFull)
									return bDone ? cb('done') : cb();
								book.insertRemainderBuyerOrder(conn, buyer_order, transacted_satoshis, function(){
									bDone ? cb('done') : cb();
								});
							});
						},
						function(err){
							if (!err)
								throw Error('buyer rows not interrupted');
							onDone();
						}
					);
				}
			);
		});
	});
}

function handleInstantBuyOrder(conn, byte_buyer_deposit_id, satoshi_amount, device_address, onDone){
	var byte_amount = book.satoshis2bytes(satoshi_amount, buy_rate);
	conn.query("SELECT * FROM byte_seller_orders WHERE is_active=1 AND price<=? ORDER BY price ASC, last_update ASC", [buy_rate], function(seller_rows){
		var total_bytes = seller_rows.reduce(function(acc, seller_order){ return acc + seller_order.byte_amount; }, 0);
		if (total_bytes < byte_amount){
			book.insertBuyerOrder(conn, byte_buyer_deposit_id, satoshi_amount, device_address, buy_rate, function(){
				var device = require('byteballcore/device.js');
				device.sendMessageToDevice(device_address, 'text', "Your payment is now confirmed but there's not enough liquidity to complete the exchange.  We'll exchange your bitcoins as soon as possible.");
			});
			return onDone();
		}
		book.finishBuyerDeposit(conn, byte_buyer_deposit_id, 0, satoshi_amount, function(){
			conn.query(
				"INSERT INTO byte_buyer_instant_deals (byte_buyer_deposit_id, satoshi_amount, byte_amount, price) VALUES (?,?,?,?)", 
				[byte_buyer_deposit_id, satoshi_amount, byte_amount, buy_rate],
				function(res){
					var byte_buyer_instant_deal_id = res.insertId;
					var remaining_byte_amount = byte_amount;
					async.eachSeries(
						seller_rows,
						function(seller_order, cb){
							var execution_price = seller_order.price;
							var bFull = (remaining_byte_amount >= seller_order.byte_amount); // full execution of the book order
							var bDone = (remaining_byte_amount <= seller_order.byte_amount);
							var transacted_bytes = bFull ? seller_order.byte_amount : remaining_byte_amount;
							var transacted_satoshis = book.bytes2satoshis(transacted_bytes, execution_price);
							if (transacted_satoshis === 0)
								throw Error("transacted_satoshis=0");
							var seller_order_props = {
								execution_price: execution_price, 
								transacted_satoshis: transacted_satoshis, 
								transacted_bytes: transacted_bytes, 
								byte_buyer_instant_deal_id: byte_buyer_instant_deal_id
							};
							book.markSellerOrderMatched(conn, seller_order.byte_seller_order_id, seller_order_props, function(){
								remaining_byte_amount -= transacted_bytes;
								if (bFull)
									return bDone ? cb('done') : cb();
								book.insertRemainderSellerOrder(conn, seller_order, transacted_bytes, function(){
									bDone ? cb('done') : cb();
								});
							});
						},
						function(err){
							if (!err)
								throw Error('seller rows not interrupted');
							onDone();
						}
					);
				}
			);
		});
	});
}


function updateInstantRates(){
	db.query("SELECT price, byte_amount FROM byte_seller_orders WHERE is_active=1 ORDER BY price ASC, last_update ASC", function(rows){
		var accumulated_bytes = 0;
		var bFound = false;
		var price;
		var max_price = SAFE_BUY_RATE;
		for (var i=0; i<rows.length; i++){
			price = rows[i].price;
			if (price > max_price)
				max_price = price;
			accumulated_bytes += rows[i].byte_amount;
			if (accumulated_bytes >= MAX_GB*1e9){
				bFound = true;
				break;
			}
		}
		if (!bFound){
			buy_rate = max_price;
			return notifications.notifyAdmin('not enough sell-side liquidity');
		}
		buy_rate = Math.round(price*(1+INSTANT_MARGIN)*10000)/10000;
	});
	db.query("SELECT price, satoshi_amount FROM byte_buyer_orders WHERE is_active=1 ORDER BY price DESC, last_update ASC", function(rows){
		var accumulated_satoshis = 0;
		var bFound = false;
		var price;
		var min_price = SAFE_SELL_RATE;
		for (var i=0; i<rows.length; i++){
			price = rows[i].price;
			if (price < min_price)
				min_price = price;
			accumulated_satoshis += rows[i].satoshi_amount;
			if (accumulated_satoshis >= MAX_BTC*1e8){
				bFound = true;
				break;
			}
		}
		if (!bFound){
			sell_rate = min_price;
			return notifications.notifyAdmin('not enough buy-side liquidity');
		}
		sell_rate = Math.round(price/(1+INSTANT_MARGIN)*10000)/10000;
	});
}

eventBus.on('book_changed', updateInstantRates);

exports.MAX_BTC = MAX_BTC;
exports.MAX_GB = MAX_GB;
exports.getBuyRate = getBuyRate;
exports.getSellRate = getSellRate;
exports.handleInstantSellOrder = handleInstantSellOrder;
exports.handleInstantBuyOrder = handleInstantBuyOrder;
exports.updateInstantRates = updateInstantRates;

