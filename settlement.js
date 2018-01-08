/*jslint node: true */
'use strict';
var util = require('util');
var async = require('byteballcore/node_modules/async');
var client = require('./bitcoin_client.js');
var db = require('byteballcore/db.js');
var mutex = require('byteballcore/mutex.js');
var eventBus = require('byteballcore/event_bus.js');
var headlessWallet = require('headless-byteball');
var notifications = require('./notifications.js');




// amount in BTC
function sendBtc(amount, address, onDone){
	client.sendToAddress(address, amount, function(err, txid, resHeaders) {
		console.log('bitcoin sendToAddress '+address+', amount '+amount+', txid '+txid+', err '+err);
		if (err && err+'' === 'Error: Transaction amount too small'){
			err = null;
			txid = 'too small';
		}
		if (err)
			return onDone(err);
		onDone(null, txid);
	});
}

function settleInstantBtc(){
	mutex.lock(['settle_btc'], function(unlock){
		db.query(
			"SELECT satoshi_amount, byte_seller_instant_deals.byte_amount, out_bitcoin_address, device_address, byte_seller_instant_deal_id \n\
			FROM byte_seller_instant_deals \n\
			JOIN byte_seller_deposits USING(byte_seller_deposit_id) \n\
			JOIN byte_seller_bindings USING(byte_seller_binding_id) \n\
			WHERE execution_date IS NULL",
			function(rows){
				async.eachSeries(
					rows,
					function(row, cb){
						var txid;
						db.executeInTransaction(function(conn, onTransactionDone){
							conn.query(
								"INSERT INTO byte_seller_instant_deal_executions (byte_seller_instant_deal_id) VALUES(?)", 
								[row.byte_seller_instant_deal_id], 
								function(){
									sendBtc(row.satoshi_amount/1e8, row.out_bitcoin_address, function(err, _txid){
										if (err){
											notifications.notifyAdminAboutFailedPayment("sending instant "+(row.satoshi_amount/1e8)+" BTC to "+row.out_bitcoin_address+": "+err);
											return onTransactionDone(err); // would rollback
										}
										txid = _txid;
										console.log('sent instant payment '+row.byte_seller_instant_deal_id+': '+(row.satoshi_amount/1e8)+' BTC in exchange for '+row.byte_amount+' bytes');
										onTransactionDone(); // executions will be committed now
									});
								}
							);
						}, function(err){
							if (err)
								return cb();
							if (!txid)
								throw Error('no txid');
							db.query(
								"UPDATE byte_seller_instant_deals SET execution_date="+db.getNow()+", txid=? WHERE byte_seller_instant_deal_id=?", 
								[txid, row.byte_seller_instant_deal_id], 
								function(){
									var device = require('byteballcore/device.js');
									device.sendMessageToDevice(row.device_address, 'text', "Sent "+(row.satoshi_amount/1e8)+" BTC.  Exchange complete, thank you for using our services!");
									cb();
								}
							);
						});
					},
					unlock
				);
			}
		);
	});
}

function settleBookBtc(){
	mutex.lock(['settle_btc'], function(unlock){
		db.query(
			"SELECT satoshi_amount, sold_byte_amount, out_bitcoin_address, byte_seller_orders.device_address, byte_seller_order_id \n\
			FROM byte_seller_orders \n\
			JOIN byte_seller_deposits USING(byte_seller_deposit_id) \n\
			JOIN byte_seller_bindings USING(byte_seller_binding_id) \n\
			WHERE is_active=0 AND execution_date IS NULL",
			function(rows){
				async.eachSeries(
					rows,
					function(row, cb){
						var txid;
						db.executeInTransaction(function(conn, onTransactionDone){
							conn.query(
								"INSERT INTO byte_seller_order_executions (byte_seller_order_id) VALUES(?)", 
								[row.byte_seller_order_id], 
								function(){
									sendBtc(row.satoshi_amount/1e8, row.out_bitcoin_address, function(err, _txid){
										if (err){
											notifications.notifyAdminAboutFailedPayment("sending book "+(row.satoshi_amount/1e8)+" BTC to "+row.out_bitcoin_address+": "+err);
											return onTransactionDone(err); // would rollback
										}
										txid = _txid;
										console.log('sent book payment '+row.byte_seller_order_id+': '+(row.satoshi_amount/1e8)+' BTC in exchange for '+row.sold_byte_amount+' bytes');
										onTransactionDone(); // executions will be committed now
									});
								}
							);
						}, function(err){
							if (err)
								return cb();
							if (!txid)
								throw Error('no txid');
							db.query(
								"UPDATE byte_seller_orders SET execution_date="+db.getNow()+", txid=? WHERE byte_seller_order_id=?", 
								[txid, row.byte_seller_order_id], 
								function(){
									var device = require('byteballcore/device.js');
									device.sendMessageToDevice(row.device_address, 'text', "Sent "+(row.satoshi_amount/1e8)+" BTC.  See in the list of [orders](command:orders) if any of your orders are still pending");
									cb();
								}
							);
						});
					},
					unlock
				);
			}
		);
	});
}

function settleInstantBytes(){
	mutex.lock(['settle_bytes'], function(unlock){
		db.query(
			"SELECT byte_buyer_instant_deals.satoshi_amount, byte_amount, out_byteball_address, device_address, byte_buyer_instant_deal_id \n\
			FROM byte_buyer_instant_deals \n\
			JOIN byte_buyer_deposits USING(byte_buyer_deposit_id) \n\
			JOIN byte_buyer_bindings USING(byte_buyer_binding_id) \n\
			WHERE execution_date IS NULL",
			function(rows){
				async.eachSeries(
					rows,
					function(row, cb){
						headlessWallet.issueChangeAddressAndSendPayment(null, row.byte_amount, row.out_byteball_address, row.device_address, function(err, unit){
							if (err){
								notifications.notifyAdminAboutFailedPayment(err);
								return cb();
							}
							console.log('sent payment '+row.byte_buyer_instant_deal_id+': '+row.byte_amount+' bytes in exchange for '+(row.satoshi_amount/1e8)+' BTC');
							db.query(
								"INSERT INTO byte_buyer_instant_deal_executions (byte_buyer_instant_deal_id) VALUES(?)", 
								[row.byte_buyer_instant_deal_id], 
								function(){
									db.query(
										"UPDATE byte_buyer_instant_deals SET execution_date="+db.getNow()+", unit=? WHERE byte_buyer_instant_deal_id=?", 
										[unit, row.byte_buyer_instant_deal_id], 
										function(){
											var device = require('byteballcore/device.js');
											device.sendMessageToDevice(row.device_address, 'text', "Sent "+(row.byte_amount/1e9)+" GB.  Exchange complete, thank you for using our services!");
											cb();
										}
									);
								}
							);
						});
					},
					unlock
				);
			}
		);
	});
}

function settleBookBytes(){
	mutex.lock(['settle_bytes'], function(unlock){
		db.query(
			"SELECT sold_satoshi_amount, byte_amount, out_byteball_address, byte_buyer_bindings.device_address, byte_buyer_order_id \n\
			FROM byte_buyer_orders \n\
			JOIN byte_buyer_deposits USING(byte_buyer_deposit_id) \n\
			JOIN byte_buyer_bindings USING(byte_buyer_binding_id) \n\
			WHERE is_active=0 AND execution_date IS NULL",
			function(rows){
				async.eachSeries(
					rows,
					function(row, cb){
						headlessWallet.issueChangeAddressAndSendPayment(null, row.byte_amount, row.out_byteball_address, row.device_address, function(err, unit){
							if (err){
								notifications.notifyAdminAboutFailedPayment(err);
								return cb();
							}
							console.log('sent payment '+row.byte_buyer_order_id+': '+row.byte_amount+' bytes in exchange for '+(row.sold_satoshi_amount/1e8)+' BTC');
							db.query("INSERT INTO byte_buyer_order_executions (byte_buyer_order_id) VALUES(?)", [row.byte_buyer_order_id], function(){
								db.query(
									"UPDATE byte_buyer_orders SET execution_date="+db.getNow()+", unit=? WHERE byte_buyer_order_id=?", 
									[unit, row.byte_buyer_order_id], 
									function(){
										var device = require('byteballcore/device.js');
										device.sendMessageToDevice(row.device_address, 'text', "Sent "+(row.byte_amount/1e9)+" GB.  See in the list of [orders](command:orders) if any of your orders are still pending");
										cb();
									}
								);
							});
						});
					},
					unlock
				);
			}
		);
	});
}


exports.settleInstantBtc = settleInstantBtc;
exports.settleBookBtc = settleBookBtc;
exports.settleInstantBytes = settleInstantBytes;
exports.settleBookBytes = settleBookBytes;
