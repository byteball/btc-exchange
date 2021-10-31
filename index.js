/*jslint node: true */
'use strict';
var util = require('util');
var async = require('async');
var bitcore = require('bitcore-lib');
var EventEmitter = require('events').EventEmitter;
var client = require('./bitcoin_client.js');
var notifications = require('./notifications.js');
var settlement = require('./settlement.js');
var book = require('./book.js');
var instant = require('./instant.js');
var conf = require('ocore/conf.js');
var constants = require('ocore/constants.js');
var db = require('ocore/db.js');
var mutex = require('ocore/mutex.js');
var eventBus = require('ocore/event_bus.js');
var ValidationUtils = require("ocore/validation_utils.js");
var desktopApp = require('ocore/desktop_app.js');
var headlessWallet = require('headless-obyte');
var api = require('./api.js');


const MIN_CONFIRMATIONS = 2;
const MIN_SATOSHIS = 200000; // typical fee is 0.0008 BTC = 80000 sat
const MIN_BYTES = 3e8;

var bTestnet = constants.version.match(/t$/);
var wallet;
var bitcoinNetwork = bTestnet ? bitcore.Networks.testnet : bitcore.Networks.livenet;


process.on('unhandledRejection', async up => {
	console.log('unhandledRejection event', up);
	process.exit(1);
});


function readCurrentState(device_address, handleState){
	db.query("SELECT state FROM states WHERE device_address=?", [device_address], function(rows){
		if (rows.length > 0)
			return handleState(rows[0].state);
		var state = "greeting";
		db.query("INSERT "+db.getIgnore()+" INTO states (device_address, state) VALUES (?,?)", [device_address, state], function(){
			handleState(state);
		});
	});
}

function updateState(device_address, state, onDone){
	db.query("UPDATE states SET state=? WHERE device_address=?", [state, device_address], function(){
		if (onDone)
			onDone();
	});
}

function readCurrentOrderPrice(device_address, order_type, handlePrice){
	var func = (order_type === 'buy') ? 'MAX' : 'MIN';
	db.query(
		"SELECT "+func+"(price) AS best_price FROM byte_"+order_type+"er_orders WHERE device_address=? AND is_active=1", 
		[device_address], 
		function(rows){
			if (rows.length === 0)
				return handlePrice(null);
			handlePrice(rows[0].best_price);
		}
	);
}

function readCurrentPrices(device_address, handlePrices){
	db.query("SELECT buy_price, sell_price FROM current_prices WHERE device_address=?", [device_address], function(rows){
		if (rows.length === 0)
			return handlePrices(null, null);
		handlePrices(rows[0].buy_price, rows[0].sell_price);
	});
}



function assignOrReadDestinationBitcoinAddress(device_address, out_byteball_address, handleBitcoinAddress){
	mutex.lock([device_address], function(device_unlock){
		db.query("SELECT to_bitcoin_address FROM byte_buyer_bindings WHERE out_byteball_address=?", [out_byteball_address], function(rows){
			if (rows.length > 0){ // already know this Obyte address
				device_unlock()
				return handleBitcoinAddress(rows[0].to_bitcoin_address);
			}
			// generate new address
			mutex.lock(["new_bitcoin_address"], async function(unlock){
				const to_bitcoin_address = await client.getNewAddress();
				console.log('BTC Address:', to_bitcoin_address);
				db.query(
					"INSERT "+db.getIgnore()+" INTO byte_buyer_bindings \n\
					(device_address, out_byteball_address, to_bitcoin_address) VALUES (?,?,?)", 
					[device_address, out_byteball_address, to_bitcoin_address],
					function(){
						unlock();
						device_unlock();
						handleBitcoinAddress(to_bitcoin_address);
					}
				);
			});
		});
	});
}

function assignOrReadDestinationByteballAddress(device_address, out_bitcoin_address, handleByteballAddress){
	mutex.lock([device_address], function(device_unlock){
		db.query("SELECT to_byteball_address FROM byte_seller_bindings WHERE out_bitcoin_address=?", [out_bitcoin_address], function(rows){
			if (rows.length > 0){ // already know this bitcoin address
				device_unlock();
				return handleByteballAddress(rows[0].to_byteball_address);
			}
			// generate new address
			mutex.lock(["new_byteball_address"], function(unlock){
				var walletDefinedByKeys = require('ocore/wallet_defined_by_keys.js');
				walletDefinedByKeys.issueNextAddress(wallet, 0, function(objAddress){
					var to_byteball_address = objAddress.address;
					db.query(
						"INSERT "+db.getIgnore()+" INTO byte_seller_bindings \n\
						(device_address, to_byteball_address, out_bitcoin_address) VALUES (?,?,?)", 
						[device_address, to_byteball_address, out_bitcoin_address],
						function(){
							unlock();
							device_unlock();
							handleByteballAddress(to_byteball_address);
						}
					);
				});
			});
		});
	});
}




function exchangeBytesToBtc(byte_seller_deposit_id, onDone){
	if (!onDone)
		onDone = function(){};
	db.query(
		"SELECT byte_amount, out_bitcoin_address, byte_seller_bindings.device_address, finality_date, sell_price \n\
		FROM byte_seller_deposits JOIN byte_seller_bindings USING(byte_seller_binding_id) LEFT JOIN current_prices USING(device_address) \n\
		WHERE byte_seller_deposit_id=?",
		[byte_seller_deposit_id],
		function(rows){
			if (rows.length !== 1)
				throw Error('byte seller deposit not found '+byte_seller_deposit_id);
			var row = rows[0];
			if (row.finality_date) // already exchanged
				return onDone();
			db.executeInTransaction(function(conn, onTransactionDone){
				if (row.sell_price)
					book.insertSellerOrder(conn, byte_seller_deposit_id, row.byte_amount, row.device_address, row.sell_price, onTransactionDone);
				else
					instant.handleInstantSellOrder(conn, byte_seller_deposit_id, row.byte_amount, row.device_address, onTransactionDone);
			}, function(){
				updateState(row.device_address, 'done');
				if (row.sell_price)
					book.matchUnderLock();
				else{
					// we do settlement after the db transaction is closed
					settlement.settleInstantBtc();
					settlement.settleBookBytes();
					instant.updateInstantRates();
				}
				onDone();
			});
		}
	);
}

function exchangeBtcToBytes(byte_buyer_deposit_id, onDone){
	if (!onDone)
		return new Promise(resolve => exchangeBtcToBytes(byte_buyer_deposit_id, resolve));
	db.query(
		"SELECT satoshi_amount, out_byteball_address, byte_buyer_bindings.device_address, confirmation_date, buy_price \n\
		FROM byte_buyer_deposits JOIN byte_buyer_bindings USING(byte_buyer_binding_id) LEFT JOIN current_prices USING(device_address) \n\
		WHERE byte_buyer_deposit_id=?",
		[byte_buyer_deposit_id],
		function(rows){
			if (rows.length !== 1)
				throw Error('byte buyer deposit not found '+byte_buyer_deposit_id);
			var row = rows[0];
			if (row.confirmation_date) // already exchanged
				return onDone();
			db.executeInTransaction(function(conn, onTransactionDone){
				if (row.buy_price)
					book.insertBuyerOrder(conn, byte_buyer_deposit_id, row.satoshi_amount, row.device_address, row.buy_price, onTransactionDone);
				else
					instant.handleInstantBuyOrder(conn, byte_buyer_deposit_id, row.satoshi_amount, row.device_address, onTransactionDone);
			}, function(){
				updateState(row.device_address, 'done');
				if (row.buy_price)
					book.matchUnderLock();
				else{
					settlement.settleInstantBytes();
					settlement.settleBookBtc();
					instant.updateInstantRates();
				}
				onDone();
			});
		}
	);
}


async function getBtcBalance(count_confirmations){
	return await client.getBalance('*', count_confirmations);
}

function checkSolvency(){
	var Wallet = require('ocore/wallet.js');
	Wallet.readBalance(wallet, async function(assocBalances){
		var byte_balance = assocBalances['base'].total;
		const btc_balance = await getBtcBalance(0);
		db.query("SELECT SUM(satoshi_amount) AS owed_satoshis FROM byte_buyer_orders WHERE is_active=1", function(rows){
			var owed_satoshis = rows[0].owed_satoshis || 0;
			db.query("SELECT SUM(byte_amount) AS owed_bytes FROM byte_seller_orders WHERE is_active=1", function(rows){
				var owed_bytes = rows[0].owed_bytes || 0;
				if (owed_satoshis > btc_balance*1e8 || owed_bytes > byte_balance)
					notifications.notifyAdmin("Solvency check failed:\n"+btc_balance+' BTC\n'+(owed_satoshis/1e8)+' BTC owed\n'+byte_balance+' bytes\n'+owed_bytes+' bytes owed');
			});
		});
	});
}



db.query("INSERT "+db.getIgnore()+" INTO pairing_secrets (pairing_secret, expiry_date, is_permanent) VALUES('0000', '2035-01-01', 1)");
instant.updateInstantRates();

var bHeadlessWalletReady = false;
eventBus.once('headless_wallet_ready', function(){
	if (!conf.admin_email || !conf.from_email){
		console.log("please specify admin_email and from_email in your "+desktopApp.getAppDataDir()+'/conf.json');
		process.exit(1);
	}
	headlessWallet.setupChatEventHandlers();
	headlessWallet.readSingleWallet(function(_wallet){
		wallet = _wallet;
		bHeadlessWalletReady = true;
		initChat();
	});
});



eventBus.on('new_my_transactions', function(arrUnits){
	var device = require('ocore/device.js');
	db.query(
		"SELECT byte_seller_binding_id, byte_seller_bindings.device_address, unit, amount, sell_price \n\
		FROM outputs \n\
		JOIN byte_seller_bindings ON address=to_byteball_address \n\
		LEFT JOIN current_prices USING(device_address) \n\
		WHERE unit IN(?) AND asset IS NULL",
		[arrUnits],
		function(rows){
			rows.forEach(function(row){
			//	if (book.bytes2satoshis(row.amount, row.sell_price || instant.getSellRate()) < 6000) // below dust limit
			//	if (book.bytes2satoshis(row.amount, row.sell_price || instant.getSellRate()) < MIN_SATOSHIS){ // would burn our profit into BTC fees
				if (row.amount < MIN_BYTES){ // would burn our profit into BTC fees
					db.query(
						"INSERT INTO byte_seller_deposits (byte_seller_binding_id, unit, byte_amount, fee_byte_amount, net_byte_amount, finality_date) \n\
						VALUES (?,?, ?,?,0, "+db.getNow()+")", 
						[row.byte_seller_binding_id, row.unit, row.amount, row.amount]
					);
					return device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(row.amount/1e9)+" GB but it is too small, it is considered a donation and will not be exchanged.");
				}
				db.query(
					"INSERT INTO byte_seller_deposits (byte_seller_binding_id, unit, byte_amount) VALUES (?,?,?)", 
					[row.byte_seller_binding_id, row.unit, row.amount],
					function(){
						var do_what = row.sell_price ? "add the order to the [book](command:book)" : "exchange";
						device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(row.amount/1e9)+" GB but it is unconfirmed yet.  We'll "+do_what+" as soon as it gets final.");
						updateState(row.device_address, 'waiting_for_confirmations');
					}
				);
			});
		}
	);
});

eventBus.on('mci_became_stable', function(mci){
	mutex.lock(["write"], function(write_unlock){
		write_unlock(); // we don't need to block writes, we requested the lock just to wait that the current write completes
		mutex.lock(["bytes2btc"], function(unlock){
			db.query(
				"SELECT byte_seller_deposit_id FROM byte_seller_deposits CROSS JOIN units USING(unit) WHERE is_stable=1 AND finality_date IS NULL", 
				function(rows){
					async.eachSeries(
						rows,
						function(row, cb){
							exchangeBytesToBtc(row.byte_seller_deposit_id, cb);
						},
						unlock
					);
					if (rows.length === 0){ // if failed to pay due to unconfirmed funds, try again
						db.query(
							"SELECT 1 FROM units CROSS JOIN outputs USING(unit) CROSS JOIN my_addresses USING(address) \n\
							WHERE is_spent=0 AND is_stable=0 AND asset IS NULL LIMIT 1", 
							function(unstable_rows){
								if (unstable_rows.length > 0)
									return;
								settlement.settleBookBytes();
								settlement.settleInstantBytes();
							}
						);
					}
				}
			);
		});
	});
});


function initChat(){
	
	var bbWallet = require('ocore/wallet.js');
	var device = require('ocore/device.js');
	
	async function readCurrentHeight() {
		const info = await client.getInfo();
		return info.blocks;
	}

	async function getLastBlock() {
		const [row] = await db.query("SELECT last_block FROM last_blocks");
		if (!row)
			throw Error(`no last block`);
		return row.last_block;
	}

	async function rescanRecentTransactions() {
		const unlock = await mutex.lockOrSkip('btc2bytes');
		if (!unlock)
			return;
		const last_block = await getLastBlock();
		const res = await client.listSinceBlock(last_block, 3);
		const { transactions, lastblock } = res;

		for (let transaction of transactions) {
			const { category, confirmations, txid, address, amount } = transaction;
			if (category !== 'receive') {
				console.log(`skipping a ${category} tx ${txid} on ${address}`);
				continue;
			}
			if (confirmations < 0) {
				console.log(`skipping tx ${txid} with ${confirmations} confirmations`);
				continue;
			}
			const rows = await db.query("SELECT count_confirmations, byte_buyer_deposit_id, confirmation_date FROM byte_buyer_deposits WHERE txid=?", [txid]);
			if (rows.length === 0) { // a new one
				await handleNewTransaction(txid, confirmations, address, amount);
			}
			else { // update an existing one
				const [{ count_confirmations }] = rows;
				if (count_confirmations === confirmations) {
					console.log(`still ${confirmations} confirmations of tx ${txid} on ${address}`);
					continue;
				}
				console.log(`tx ${txid} on ${address} now has ${confirmations} confirmations`);
				await db.query("UPDATE byte_buyer_deposits SET count_confirmations=? WHERE txid=?", [confirmations, txid]);
				if (confirmations < MIN_CONFIRMATIONS) {
					console.log(`tx ${txid} on ${address}: not enough confirmations yet`);
					continue;
				}
				for (let { byte_buyer_deposit_id, confirmation_date } of rows) {
					if (confirmation_date)
						console.log(`tx ${txid} on ${address}: deposit ${byte_buyer_deposit_id} already confirmed`);
					else
						await exchangeBtcToBytes(byte_buyer_deposit_id);
				}
			}
		}

		if (lastblock !== last_block)
			await db.query("UPDATE last_blocks SET last_block=?", [lastblock]);
		unlock();
	}
	
	
	
	
	
	/////////////////////////////////
	// start
	
	setInterval(checkSolvency, 10000);

	eventBus.on('paired', function(from_address){
		readCurrentState(from_address, function(state){
			if (state === 'waiting_for_confirmations')
				return device.sendMessageToDevice(from_address, 'text', "Received your payment and waiting that it is confirmed.");
			updateState(from_address, 'greeting');
			device.sendMessageToDevice(from_address, 'text', "Here you can:\n[buy bytes](command:buy) at "+instant.getBuyRate()+" BTC/GB\n[sell bytes](command:sell) at "+instant.getSellRate()+" BTC/GB\nor [set your price](command:set price).");
		});
	});

	eventBus.on('text', async function(from_address, text){
		text = text.trim();
		var lc_text = text.toLowerCase();
		
		if (headlessWallet.isControlAddress(from_address)){
			if (lc_text === 'balance') {
				const balance = await getBtcBalance(0);
				const confirmed_balance = await getBtcBalance(1);
				var unconfirmed_balance = balance - confirmed_balance;
				var btc_balance_str = balance + ' BTC';
				if (unconfirmed_balance)
					btc_balance_str += ' (' + unconfirmed_balance + ' unconfirmed)';
				db.query("SELECT SUM(satoshi_amount) AS owed_satoshis FROM byte_buyer_orders WHERE is_active=1", function (rows) {
					var owed_satoshis = rows[0].owed_satoshis || 0;
					db.query("SELECT SUM(byte_amount) AS owed_bytes FROM byte_seller_orders WHERE is_active=1", function (rows) {
						var owed_bytes = rows[0].owed_bytes || 0;
						device.sendMessageToDevice(from_address, 'text', btc_balance_str + '\n' + (owed_satoshis / 1e8) + ' BTC owed\n' + owed_bytes + ' bytes owed');
					});
				});
				return;
			}
		}
		
		readCurrentState(from_address, function(state){
			console.log('state='+state);
			
			if (lc_text === 'buy'){
				device.sendMessageToDevice(from_address, 'text', "Buying at "+instant.getBuyRate()+" BTC/GB.  Please let me know your Obyte address (just click \"...\" button and select \"Insert my address\").");
				book.updateCurrentPrice(from_address, 'buy', null);
				updateState(from_address, 'waiting_for_byteball_address');
				return;
			}
			if (lc_text === 'sell'){
				device.sendMessageToDevice(from_address, 'text', "Selling at "+instant.getSellRate()+" BTC/GB.  Please let me know your Bitcoin address.");
				book.updateCurrentPrice(from_address, 'sell', null);
				updateState(from_address, 'waiting_for_bitcoin_address');
				return;
			}
			if (lc_text === 'rates' || lc_text === 'rate'){
				device.sendMessageToDevice(from_address, 'text', "You can:\n[buy bytes](command:buy) at "+instant.getBuyRate()+" BTC/GB\n[sell bytes](command:sell) at "+instant.getSellRate()+" BTC/GB\nor [set your price](command:set price).");
				return;
			}
			if (lc_text === 'set price'){
				db.query("SELECT MAX(price) AS bid FROM byte_buyer_orders WHERE is_active=1", function(rows){
					var bid = rows[0].bid;
					db.query("SELECT MIN(price) AS ask FROM byte_seller_orders WHERE is_active=1", function(rows){
						var ask = rows[0].ask;
						var arrSuggestions = [];
						const STEP = 0.0001;
						if (ask)
							arrSuggestions.push('[Buy at '+ask+' BTC/GB](command:buy at '+ask+') - fast');
						if (bid){
							var front_runninng_bid = bid + STEP;
							if (ask && front_runninng_bid >= ask)
								front_runninng_bid = bid;
							arrSuggestions.push('[Buy at '+front_runninng_bid+' BTC/GB](command:buy at '+front_runninng_bid+') - have to wait');
							arrSuggestions.push('[Sell at '+bid+' BTC/GB](command:sell at '+bid+') - fast');
						}
						if (ask){
							var front_runninng_ask = ask - STEP;
							if (bid && front_runninng_ask <= bid)
								front_runninng_ask = ask;
							arrSuggestions.push('[Sell at '+front_runninng_ask+' BTC/GB](command:sell at '+front_runninng_ask+') - have to wait');
						}
						var start_of_sentence = (arrSuggestions.length === 0) ? 'T' : 'Or, see the [book](command:book) and t';
						arrSuggestions.push(start_of_sentence+'ype your price, for example "buy at <price>" or "sell at <price>". The lower your buy price, or the higher your sell price, the longer you\'ll have to wait.\n\nAfter your order is added to the [book](command:book), you\'ll be able to change your price but you can\'t withdraw the original funds without completing an exchange.  Deposit fee is '+book.FEE_PERCENT+'% and it is the only fee charged.');
						device.sendMessageToDevice(from_address, 'text', arrSuggestions.join('\n'));
					});
				});
				return;
			}
			if (lc_text === 'orders' || lc_text === 'book'){

				book.getOrders(lc_text === 'orders' ? from_address : null,
					function(rows){
						var arrLines = rows.map(row => "At "+row.price+" BTC/GB "+row.order_type+" vol. "+row.total+" GB");
						if (lc_text === 'book'){
							let firstBuyIndex = rows.findIndex(row => { return (row.order_type === 'buy'); });
							if (firstBuyIndex >= 0)
								arrLines.splice(firstBuyIndex, 0, '');
						}
						device.sendMessageToDevice(from_address, 'text', arrLines.join("\n") || "No orders at this time.");
					}
				);
				return;
			}
			if (lc_text === 'help')
				return device.sendMessageToDevice(from_address, 'text', "List of commands:\n[book](command:book): see the order book;\n[orders](command:orders): see your orders;\n[rates](command:rates): see buy and sell rates for instant exchange;\n[buy](command:buy): buy at instant rate;\n[sell](command:sell): sell at instant rate;\n[set price](command:set price): see suggested buy and sell prices;\nbuy at <price>: add a limit buy order at <price> or change the price of the existing buy orders;\nsell at <price>: add a limit sell order at <price> or change the price of the existing sell orders.");
			
			var bSetNewPrice = false;
			var arrMatches = lc_text.match(/(buy|sell) at ([\d.]+)/);
			if (arrMatches){
				var order_type = arrMatches[1];
				var price = parseFloat(arrMatches[2]);
				if (price){
					readCurrentOrderPrice(from_address, order_type, function(best_price){
						/*if (best_price){
							if (order_type === 'buy' && price < best_price)
								return device.sendMessageToDevice(from_address, 'text', "Buy price of existing orders can only be increased");
							if (order_type === 'sell' && price > best_price)
								return device.sendMessageToDevice(from_address, 'text', "Sell price of existing orders can only be decreased");
						}*/
						book.updateCurrentPrice(from_address, order_type, price, function(){
							var response = (order_type === 'buy' ? 'Buying' : 'Selling')+' at '+price+' BTC/GB.';
							if (!best_price){
								response += '.\n' + (order_type === 'buy' ? "Please let me know your Obyte address (just click \"...\" button and select \"Insert my address\")." : "Please let me know your Bitcoin address.");
								updateState(from_address, (order_type === 'buy') ? 'waiting_for_byteball_address' : 'waiting_for_bitcoin_address');
							}
							device.sendMessageToDevice(from_address, 'text', response);
						});
					});
					bSetNewPrice = true;
				}
			}

			if (lc_text.indexOf("alias") === 0 && lc_text.split(" ").length === 2){
				var alias_address = lc_text.split(" ")[1].toUpperCase();
				if (ValidationUtils.isValidDeviceAddress(alias_address)){
					api.setAlias(from_address, alias_address, function(err){
						if (err)
							return device.sendMessageToDevice(from_address, 'text', err);
						device.sendMessageToDevice(from_address, 'text', "Your new alias device address for API is: " + alias_address);
					});
				} else {
					device.sendMessageToDevice(from_address, 'text',alias_address +  " is not a valid device address.");
				}
				return;
			}

			if (lc_text === "remove alias"){
				api.removeAlias(from_address, function(){
					device.sendMessageToDevice(from_address, 'text', "Alias address has been removed.");
				});
				return;
			}

			var arrMatches = text.match(/\b([A-Z2-7]{32})\b/);
			var bValidByteballAddress = (arrMatches && ValidationUtils.isValidAddress(arrMatches[1]));
			if (bValidByteballAddress){ // new BB address: create or update binding
				var out_byteball_address = arrMatches[1];
				assignOrReadDestinationBitcoinAddress(from_address, out_byteball_address, function(to_bitcoin_address){
					readCurrentPrices(from_address, function(buy_price, sell_price){
						var will_do_text = buy_price 
							? 'Your bitcoins will be added to the [book](command:book) at '+buy_price+' BTC/GB when the payment has at least '+MIN_CONFIRMATIONS+' confirmations.  You\'ll be able to change the price at any time by typing "buy at <new price>".' 
							: "Your bitcoins will be exchanged when the payment has at least "+MIN_CONFIRMATIONS+" confirmations, at the rate actual for that time, which may differ from the current rate ("+instant.getBuyRate()+" BTC/GB).";
						var maximum_text = buy_price ? "" : "maximum amount is "+instant.MAX_BTC+" BTC,";
						device.sendMessageToDevice(from_address, 'text', "Got it, you'll receive your bytes to "+out_byteball_address+".  Now please pay BTC to "+to_bitcoin_address+".  We'll exchange as much as you pay, but the "+maximum_text+" minimum is "+(MIN_SATOSHIS/1e8)+" BTC (if you send less, it'll be considered a donation).  "+will_do_text);
					});
					updateState(from_address, 'waiting_for_payment');
				});
				return;
			}
			else if (state === 'waiting_for_byteball_address' && !bSetNewPrice)
				return device.sendMessageToDevice(from_address, 'text', "This doesn't look like a valid Byteball address.  Please click \"...\" button at the bottom of the screen and select \"Insert my address\", then hit \"Send\" button.");
			
			var bValidBitcoinAddress = bitcore.Address.isValid(text, bitcoinNetwork);
			if (bValidBitcoinAddress){
				var out_bitcoin_address = text;
				assignOrReadDestinationByteballAddress(from_address, out_bitcoin_address, function(to_byteball_address){
					readCurrentPrices(from_address, function(buy_price, sell_price){
						var will_do_text = sell_price 
							? 'Your bytes will be added to the [book](command:book) at '+sell_price+' BTC/GB when the payment is final.  You\'ll be able to change the price at any time by typing "sell at <new price>".' 
							: "Your bytes will be exchanged when the payment is final, at the rate actual for that time, which may differ from the current rate ("+instant.getSellRate()+" BTC/GB).";
						var maximum_text = sell_price ? "" : "maximum amount is "+instant.MAX_GB+" GB,";
						device.sendMessageToDevice(from_address, 'text', "Got it, you'll receive your BTC to "+out_bitcoin_address+".  Now please pay bytes to "+to_byteball_address+".  We'll exchange as much as you pay, but the "+maximum_text+" minimum is "+(MIN_BYTES/1e9)+" GB (if you send less, it'll be considered a donation).  "+will_do_text);
					});
					updateState(from_address, 'waiting_for_payment');
				});
				return;
			}
			else if (state === 'waiting_for_bitcoin_address' && !bSetNewPrice)
				return device.sendMessageToDevice(from_address, 'text', "This doesn't look like a valid Bitcoin address.");
			
			if (bSetNewPrice)
				return;
			
			switch(state){
				case 'greeting':
					device.sendMessageToDevice(from_address, 'text', "To start an exchange, see the current [rates](command:rates) or [set your price](command:set price).");
					break;
					
				case 'waiting_for_payment':
					device.sendMessageToDevice(from_address, 'text', "Waiting for your payment.  If you want to start another exchange, see the current [rates](command:rates) or [set your price](command:set price).");
					break;

				case 'waiting_for_confirmations':
					device.sendMessageToDevice(from_address, 'text', "Received your payment and waiting that it is confirmed.");
					break;
					
				case 'done':
					device.sendMessageToDevice(from_address, 'text', "If you want to start another exchange, see the current [rates](command:rates) or [set your price](command:set price).");
					break;
					
				default:
					throw Error("unknown state: "+state);
			}
		});
	});
	
	
	async function handleNewTransaction(txid, count_confirmations, to_bitcoin_address, amount) {
		const received_satoshis = Math.round(amount * 1e8);
		const rows = await db.query(
			"SELECT byte_buyer_bindings.device_address, byte_buyer_binding_id, buy_price \n\
			FROM byte_buyer_bindings LEFT JOIN current_prices USING(device_address) \n\
			WHERE to_bitcoin_address=?",
			[to_bitcoin_address]
		);
		if (rows.length === 0)
			return console.log("unexpected payment", txid, to_bitcoin_address, amount);
		if (rows.length > 1)
			throw Error("more than 1 row per to btc address");
		var row = rows[0];
		if (received_satoshis < MIN_SATOSHIS){ // would burn our profit into BTC fees
			await db.query(
				"INSERT "+db.getIgnore()+" INTO byte_buyer_deposits \n\
				(byte_buyer_binding_id, txid, satoshi_amount, fee_satoshi_amount, net_satoshi_amount, confirmation_date) \n\
				VALUES (?,?, ?,?,0, "+db.getNow()+")", 
				[row.byte_buyer_binding_id, txid, received_satoshis, received_satoshis]
			);
			return device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(received_satoshis/1e8)+" BTC but it is too small, it is considered a donation and will not be exchanged.");
		}
		const res = await db.query(
			"INSERT " + db.getIgnore() + " INTO byte_buyer_deposits \n\
			(byte_buyer_binding_id, txid, satoshi_amount, count_confirmations) VALUES(?,?,?,?)",
			[row.byte_buyer_binding_id, txid, received_satoshis, count_confirmations]
		);
		console.log('byte_buyer_deposits res: '+JSON.stringify(res));
		if (!res.affectedRows)
			return console.log("duplicate transaction");
		if (count_confirmations >= MIN_CONFIRMATIONS)
			return await exchangeBtcToBytes(res.insertId);
		var do_what = row.buy_price ? "add the order to the [book](command:book)" : "exchange";
		device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(received_satoshis/1e8)+" BTC but it is unconfirmed yet.  We'll "+do_what+" as soon as it gets at least "+MIN_CONFIRMATIONS+" confirmations.");
		updateState(row.device_address, 'waiting_for_confirmations');
	}
	
	rescanRecentTransactions();
	setInterval(rescanRecentTransactions, 10 * 1000);
	
}
