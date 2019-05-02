/*jslint node: true */
'use strict';
var notifications = require('./notifications.js');
var settlement = require('./settlement.js');
var conf = require('ocore/conf.js');
var db = require('ocore/db.js');
var mutex = require('ocore/mutex.js');
var eventBus = require('ocore/event_bus.js');

const FEE = conf.FEE || 0.002;


function satoshis2bytes(satoshi_amount, price){
	if (!satoshi_amount || !price)
		throw Error('wrong inputs to satoshis2bytes amount='+satoshi_amount+', price='+price);
	return Math.round(10 * satoshi_amount / price);
}

function bytes2satoshis(byte_amount, price){
	if (!byte_amount || !price)
		throw Error('wrong inputs to bytes2satoshis amount='+byte_amount+', price='+price);
	var satoshis = Math.round(byte_amount * price / 10);
//	if (satoshis <= 0)
//		throw Error('satoshis = '+satoshis);
	return satoshis;
}

function finishBuyerDeposit(conn, byte_buyer_deposit_id, fee_satoshi_amount, net_satoshi_amount, onDone){
	conn.query(
		"UPDATE byte_buyer_deposits SET fee_satoshi_amount=?, net_satoshi_amount=?, confirmation_date="+db.getNow()+" WHERE byte_buyer_deposit_id=?",
		[fee_satoshi_amount, net_satoshi_amount, byte_buyer_deposit_id],
		function(){
			onDone();
		}
	);
}

function finishSellerDeposit(conn, byte_seller_deposit_id, fee_byte_amount, net_byte_amount, onDone){
	conn.query(
		"UPDATE byte_seller_deposits SET fee_byte_amount=?, net_byte_amount=?, finality_date="+db.getNow()+" WHERE byte_seller_deposit_id=?",
		[fee_byte_amount, net_byte_amount, byte_seller_deposit_id],
		function(){
			onDone();
		}
	);
}

function insertBuyerOrder(conn, byte_buyer_deposit_id, satoshi_amount, device_address, price, onDone){
	var fee_satoshi_amount = Math.round(FEE*satoshi_amount);
	var net_satoshi_amount = satoshi_amount - fee_satoshi_amount;
	conn.query(
		"INSERT INTO byte_buyer_orders (byte_buyer_deposit_id, device_address, satoshi_amount, price) VALUES (?,?,?,?)", 
		[byte_buyer_deposit_id, device_address, net_satoshi_amount, price],
		function(){
			finishBuyerDeposit(conn, byte_buyer_deposit_id, fee_satoshi_amount, net_satoshi_amount, onDone);
			var device = require('ocore/device.js');
			device.sendMessageToDevice(device_address, 'text', "Your order to buy bytes for "+(net_satoshi_amount/1e8)+" BTC at "+price+" BTC/GB was added to the [book](command:book) (fee "+(fee_satoshi_amount/1e8)+" BTC)");
		}
	);
}

function insertSellerOrder(conn, byte_seller_deposit_id, byte_amount, device_address, price, onDone){
	var fee_byte_amount = Math.round(FEE*byte_amount);
	var net_byte_amount = byte_amount - fee_byte_amount;
	conn.query(
		"INSERT INTO byte_seller_orders (byte_seller_deposit_id, device_address, byte_amount, price) VALUES (?,?,?,?)", 
		[byte_seller_deposit_id, device_address, net_byte_amount, price],
		function(){
			finishSellerDeposit(conn, byte_seller_deposit_id, fee_byte_amount, net_byte_amount, onDone);
			var device = require('ocore/device.js');
			device.sendMessageToDevice(device_address, 'text', "Your order to sell "+(net_byte_amount/1e9)+" GB at "+price+" BTC/GB was added to the [book](command:book) (fee "+(fee_byte_amount/1e9)+" GB)");
		}
	);
}

function markBuyerOrderMatched(conn, byte_buyer_order_id, props, onDone){
	if (!props.execution_price || !props.transacted_satoshis || !props.transacted_bytes)
		throw Error("bad props");
	if (!props.opposite_byte_seller_order_id && !props.byte_seller_instant_deal_id)
		throw Error("no seller ref");
	if (props.opposite_byte_seller_order_id && props.byte_seller_instant_deal_id)
		throw Error("both seller refs");
	conn.query(
		"UPDATE byte_buyer_orders \n\
		SET is_active=0, match_date="+db.getNow()+", \n\
			execution_price=?, sold_satoshi_amount=?, byte_amount=?, \n\
			opposite_byte_seller_order_id=?, byte_seller_instant_deal_id=? \n\
		WHERE byte_buyer_order_id=?", 
		[props.execution_price, props.transacted_satoshis, props.transacted_bytes, 
		 props.opposite_byte_seller_order_id, props.byte_seller_instant_deal_id, 
		 byte_buyer_order_id],
		function(){
			onDone();
		}
	);
}

function markSellerOrderMatched(conn, byte_seller_order_id, props, onDone){
	if (!props.execution_price || !props.transacted_satoshis || !props.transacted_bytes)
		throw Error("bad props");
	if (!props.opposite_byte_buyer_order_id && !props.byte_buyer_instant_deal_id)
		throw Error("no buyer ref");
	if (props.opposite_byte_buyer_order_id && props.byte_buyer_instant_deal_id)
		throw Error("both buyer refs");
	conn.query(
		"UPDATE byte_seller_orders \n\
		SET is_active=0, match_date="+db.getNow()+", \n\
			execution_price=?, sold_byte_amount=?, satoshi_amount=?, \n\
			opposite_byte_buyer_order_id=?, byte_buyer_instant_deal_id=? \n\
		WHERE byte_seller_order_id=?", 
		[props.execution_price, props.transacted_bytes, props.transacted_satoshis, 
		 props.opposite_byte_buyer_order_id, props.byte_buyer_instant_deal_id, 
		 byte_seller_order_id],
		function(){
			onDone();
		}
	);
}

function insertRemainderBuyerOrder(conn, buyer_order, transacted_satoshis, onDone){
	var satoshis_left = buyer_order.satoshi_amount - transacted_satoshis;
	if (satoshis_left <= 0){
		if (satoshis_left === 0){
			console.log("0 satoshis left after rounding");
			return onDone();
		}
		throw Error('satoshis left '+satoshis_left);
	}
	conn.query(
		"INSERT INTO byte_buyer_orders \n\
		(byte_buyer_deposit_id, device_address, satoshi_amount, price, prev_byte_buyer_order_id, last_update) VALUES (?,?, ?,?, ?,?)", 
		[buyer_order.byte_buyer_deposit_id, buyer_order.device_address, satoshis_left, buyer_order.price, 
		buyer_order.byte_buyer_order_id, buyer_order.last_update],
		function(){
			onDone();
		}
	);
}

function insertRemainderSellerOrder(conn, seller_order, transacted_bytes, onDone){
	var bytes_left = seller_order.byte_amount - transacted_bytes;
	if (bytes_left <= 0)
		throw Error('bytes left '+bytes_left);
	conn.query(
		"INSERT INTO byte_seller_orders \n\
		(byte_seller_deposit_id, device_address, byte_amount, price, prev_byte_seller_order_id, last_update) VALUES (?,?, ?,?, ?,?)", 
		[seller_order.byte_seller_deposit_id, seller_order.device_address, bytes_left, seller_order.price, 
		seller_order.byte_seller_order_id, seller_order.last_update],
		function(){
			onDone();
		}
	);
}

function match(conn, onDone){
	conn.query("SELECT * FROM byte_buyer_orders WHERE is_active=1 ORDER BY price DESC, last_update ASC LIMIT 1", function(buyer_rows){
		if (buyer_rows.length === 0)
			return onDone();
		var buyer_order = buyer_rows[0];
		if (buyer_order.unit || buyer_order.execution_price || buyer_order.sold_satoshi_amount || buyer_order.byte_amount || buyer_order.match_date || buyer_order.execution_date || buyer_order.byte_seller_instant_deal_id || buyer_order.opposite_byte_seller_order_id)
			throw Error('already executed '+require('util').inspect(buyer_order));
		conn.query("SELECT * FROM byte_seller_orders WHERE is_active=1 ORDER BY price ASC, last_update ASC LIMIT 1", function(seller_rows){
			if (seller_rows.length === 0)
				return onDone();
			var seller_order = seller_rows[0];
			if (seller_order.txid || seller_order.execution_price || seller_order.sold_byte_amount || seller_order.satoshi_amount || seller_order.match_date || seller_order.execution_date || seller_order.byte_buyer_instant_deal_id || seller_order.opposite_byte_buyer_order_id)
				throw Error('already executed '+require('util').inspect(seller_order));
			if (seller_order.price > buyer_order.price)
				return onDone();
			var execution_price = (buyer_order.last_update < seller_order.last_update) ? buyer_order.price : seller_order.price;// price of the earlier order
			var full_buyer_bytes = satoshis2bytes(buyer_order.satoshi_amount, execution_price);
			var bBuyerIsFull = (full_buyer_bytes <= seller_order.byte_amount);
			var bSellerIsFull = (full_buyer_bytes >= seller_order.byte_amount);
			if (!bBuyerIsFull && !bSellerIsFull)
				throw Error('neither buyer nor seller is full');
			var transacted_bytes, transacted_satoshis;
			if (bBuyerIsFull){
				transacted_bytes = full_buyer_bytes;
				transacted_satoshis = buyer_order.satoshi_amount;
			}
			else{
				transacted_bytes = seller_order.byte_amount;
				transacted_satoshis = bytes2satoshis(transacted_bytes, execution_price);
				if (transacted_satoshis === 0)
					throw Error("transacted_satoshis = 0");
			}
			var buyer_order_props = {
				execution_price: execution_price, 
				transacted_satoshis: transacted_satoshis, 
				transacted_bytes: transacted_bytes, 
				opposite_byte_seller_order_id: seller_order.byte_seller_order_id
			};
			var seller_order_props = {
				execution_price: execution_price, 
				transacted_satoshis: transacted_satoshis, 
				transacted_bytes: transacted_bytes, 
				opposite_byte_buyer_order_id: buyer_order.byte_buyer_order_id
			};
			markBuyerOrderMatched(conn, buyer_order.byte_buyer_order_id, buyer_order_props, function(){
				markSellerOrderMatched(conn, seller_order.byte_seller_order_id, seller_order_props, function(){
					var next = function(){
						match(conn, onDone);
					};
					if (!bBuyerIsFull)
						insertRemainderBuyerOrder(conn, buyer_order, transacted_satoshis, next);
					else if (!bSellerIsFull)
						insertRemainderSellerOrder(conn, seller_order, transacted_bytes, next);
					else
						next();
				});
			});
		});
	});
}

function matchUnderLock(){
	mutex.lock(['match'], function(unlock){
		db.executeInTransaction(match, function onDone(){
			unlock();
			settlement.settleBookBtc();
			settlement.settleBookBytes();
			eventBus.emit('book_changed');
		});
	});
}


function getOrders(device_address, handle){
	var and_device = "";
	var params = [];
	if (device_address){
		and_device = " AND device_address=? ";
		params.push(device_address, device_address);
	}

	db.query(
		"SELECT price, 'sell' AS order_type, SUM(byte_amount)/1e9 AS total \n\
		FROM byte_seller_orders WHERE is_active=1 "+and_device+" \n\
		GROUP BY price \n\
		UNION ALL \n\
		SELECT price, 'buy' AS order_type, ROUND(SUM(satoshi_amount)/1e8/price, 9) AS total \n\
		FROM byte_buyer_orders WHERE is_active=1 "+and_device+" \n\
		GROUP BY price \n\
		ORDER BY price DESC",
		params, function(rows){
			return handle(rows);
		});

}

function updateCurrentPrice(device_address, order_type, price, onDone){
	if (!onDone)
		onDone = function(){};
	db.query("INSERT "+db.getIgnore()+" INTO current_prices (device_address) VALUES (?)", [device_address], function(){
		db.query("UPDATE current_prices SET "+order_type+"_price=? WHERE device_address=?", [price, device_address], function(){
			if (!price)
				return onDone();
			db.query(
				"UPDATE byte_"+order_type+"er_orders SET price=?, last_update="+db.getNow()+" WHERE device_address=? AND is_active=1", 
				[price, device_address], 
				function(){
					onDone();
					matchUnderLock();
				}
			);
		});
	});
}


exports.FEE_PERCENT = FEE*100;
exports.satoshis2bytes = satoshis2bytes;
exports.bytes2satoshis = bytes2satoshis;
exports.finishBuyerDeposit = finishBuyerDeposit;
exports.finishSellerDeposit = finishSellerDeposit;
exports.insertBuyerOrder = insertBuyerOrder;
exports.insertSellerOrder = insertSellerOrder;
exports.markBuyerOrderMatched = markBuyerOrderMatched;
exports.markSellerOrderMatched = markSellerOrderMatched;
exports.insertRemainderBuyerOrder = insertRemainderBuyerOrder;
exports.insertRemainderSellerOrder = insertRemainderSellerOrder;
exports.matchUnderLock = matchUnderLock;
exports.getOrders = getOrders;
exports.updateCurrentPrice = updateCurrentPrice;