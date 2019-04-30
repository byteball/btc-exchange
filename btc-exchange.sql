CREATE TABLE states (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_update TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	state VARCHAR(30) NOT NULL DEFAULT 'greeting',
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);


CREATE TABLE current_prices (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	buy_price DECIMAL(20, 10) NULL,
	sell_price DECIMAL(20, 10) NULL,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);

-- bindings

CREATE TABLE byte_buyer_bindings (
	byte_buyer_binding_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	out_byteball_address CHAR(32) NOT NULL UNIQUE,
	to_bitcoin_address VARCHAR(34) NOT NULL UNIQUE,
	device_address CHAR(33) NOT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);

CREATE TABLE byte_seller_bindings (
	byte_seller_binding_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	to_byteball_address CHAR(32) NOT NULL UNIQUE,
	out_bitcoin_address VARCHAR(34) NOT NULL UNIQUE,
	device_address CHAR(33) NOT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address),
	FOREIGN KEY (to_byteball_address) REFERENCES my_addresses(address)
);


-- deposits

CREATE TABLE byte_buyer_deposits (
	byte_buyer_deposit_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	byte_buyer_binding_id INTEGER NOT NULL,
	count_confirmations INT NOT NULL DEFAULT 0,
	txid CHAR(64) NOT NULL,
	satoshi_amount INT NOT NULL,
	fee_satoshi_amount INT NULL,  -- filled wnen confirmed
	net_satoshi_amount INT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	confirmation_date TIMESTAMP NULL,
	UNIQUE (txid, byte_buyer_binding_id),
	FOREIGN KEY (byte_buyer_binding_id) REFERENCES byte_buyer_bindings(byte_buyer_binding_id)
);
CREATE INDEX byBuyerDepositsConfirmation ON byte_buyer_deposits(confirmation_date);

CREATE TABLE byte_seller_deposits (
	byte_seller_deposit_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	byte_seller_binding_id INTEGER NOT NULL,
	unit CHAR(44) NOT NULL,
	byte_amount INT NOT NULL,
	fee_byte_amount INT NULL,
	net_byte_amount INT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	finality_date TIMESTAMP NULL,
	UNIQUE (unit, byte_seller_binding_id),
	FOREIGN KEY (byte_seller_binding_id) REFERENCES byte_seller_bindings(byte_seller_binding_id),
	FOREIGN KEY (unit) REFERENCES units(unit)
);
CREATE INDEX bySellerDepositsFinality ON byte_seller_deposits(finality_date);



-- instant orders

-- customer gets quoted price and is instantly filled
-- the operator realays the deal to the book on his own behalf by buying or selling against pending book orders, with a margin

CREATE TABLE byte_buyer_instant_deals (
	byte_buyer_instant_deal_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	byte_buyer_deposit_id INTEGER NOT NULL UNIQUE,
	unit CHAR(44) NULL,
	satoshi_amount INT NOT NULL,
	byte_amount INT NOT NULL,
	price DOUBLE NOT NULL,
	match_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	execution_date TIMESTAMP NULL,
	FOREIGN KEY (byte_buyer_deposit_id) REFERENCES byte_buyer_deposits(byte_buyer_deposit_id),
	FOREIGN KEY (unit) REFERENCES units(unit)
);
CREATE INDEX byBuyerInstantDealsExecution ON byte_buyer_instant_deals(execution_date);

CREATE TABLE byte_seller_instant_deals (
	byte_seller_instant_deal_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	byte_seller_deposit_id INTEGER NOT NULL UNIQUE,
	txid CHAR(64) NULL,
	satoshi_amount INT NOT NULL,
	byte_amount INT NOT NULL,
	price DOUBLE NOT NULL,
	match_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	execution_date TIMESTAMP NULL,
	FOREIGN KEY (byte_seller_deposit_id) REFERENCES byte_seller_deposits(byte_seller_deposit_id)
);
CREATE INDEX bySellerInstantDealsExecution ON byte_seller_instant_deals(execution_date);

CREATE TABLE byte_buyer_instant_deal_executions (
	byte_buyer_instant_deal_id INTEGER NOT NULL PRIMARY KEY,
	execution_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (byte_buyer_instant_deal_id) REFERENCES byte_buyer_instant_deals(byte_buyer_instant_deal_id)
);

CREATE TABLE byte_seller_instant_deal_executions (
	byte_seller_instant_deal_id INTEGER NOT NULL PRIMARY KEY,
	execution_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (byte_seller_instant_deal_id) REFERENCES byte_seller_instant_deals(byte_seller_instant_deal_id)
);

-- book orders

CREATE TABLE byte_buyer_orders (
	byte_buyer_order_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	byte_buyer_deposit_id INTEGER NOT NULL,
	prev_byte_buyer_order_id INTEGER NULL, -- after partial execution
	device_address CHAR(33) NOT NULL,
	is_active TINYINT NOT NULL DEFAULT 1,
	satoshi_amount INT NOT NULL,
	price DECIMAL(20, 10) NOT NULL,
	unit CHAR(44) NULL,
	execution_price DECIMAL(20, 10) NULL,
	sold_satoshi_amount INT NULL,
	byte_amount INT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_update TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	match_date TIMESTAMP NULL,
	execution_date TIMESTAMP NULL,
	byte_seller_instant_deal_id INT NULL, -- if executed against instant order
	FOREIGN KEY (unit) REFERENCES units(unit),
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address),
	FOREIGN KEY (byte_buyer_deposit_id) REFERENCES byte_buyer_deposits(byte_buyer_deposit_id),
	FOREIGN KEY (prev_byte_buyer_order_id) REFERENCES byte_buyer_orders(byte_buyer_order_id),
	FOREIGN KEY (byte_seller_instant_deal_id) REFERENCES byte_seller_instant_deals(byte_seller_instant_deal_id)
);
CREATE INDEX byBuyerOrdersDevice ON byte_buyer_orders(device_address);
CREATE INDEX byBuyerOrdersActivePrice ON byte_buyer_orders(is_active, price);
CREATE INDEX byBuyerOrdersActiveExecuted ON byte_buyer_orders(is_active, execution_date);

CREATE TABLE byte_seller_orders (
	byte_seller_order_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	byte_seller_deposit_id INTEGER NOT NULL,
	prev_byte_seller_order_id INTEGER NULL, -- after partial execution
	device_address CHAR(33) NOT NULL,
	is_active TINYINT NOT NULL DEFAULT 1,
	byte_amount INT NOT NULL,
	price DECIMAL(20, 10) NOT NULL,
	txid CHAR(64) NULL,
	execution_price DECIMAL(20, 10) NULL,
	sold_byte_amount INT NULL,
	satoshi_amount INT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_update TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	match_date TIMESTAMP NULL,
	execution_date TIMESTAMP NULL,
	byte_buyer_instant_deal_id INT NULL, -- if executed against instant order
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address),
	FOREIGN KEY (byte_seller_deposit_id) REFERENCES byte_seller_deposits(byte_seller_deposit_id),
	FOREIGN KEY (prev_byte_seller_order_id) REFERENCES byte_seller_orders(byte_seller_order_id),
	FOREIGN KEY (byte_buyer_instant_deal_id) REFERENCES byte_buyer_instant_deals(byte_buyer_instant_deal_id)
);
CREATE INDEX bySellerOrdersDevice ON byte_seller_orders(device_address);
CREATE INDEX bySellerOrdersActivePrice ON byte_seller_orders(is_active, price);
CREATE INDEX bySellerOrdersActiveExecuted ON byte_seller_orders(is_active, execution_date);

-- if executed against book order
ALTER TABLE byte_buyer_orders ADD COLUMN opposite_byte_seller_order_id INTEGER NULL REFERENCES byte_seller_orders(byte_seller_order_id); -- opposite order
ALTER TABLE byte_seller_orders ADD COLUMN opposite_byte_buyer_order_id INTEGER NULL REFERENCES byte_buyer_orders(byte_buyer_order_id); -- opposite order


CREATE TABLE byte_buyer_order_executions (
	byte_buyer_order_id INTEGER NOT NULL PRIMARY KEY,
	execution_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (byte_buyer_order_id) REFERENCES byte_buyer_orders(byte_buyer_order_id)
);

CREATE TABLE byte_seller_order_executions (
	byte_seller_order_id INTEGER NOT NULL PRIMARY KEY,
	execution_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (byte_seller_order_id) REFERENCES byte_seller_orders(byte_seller_order_id)
);

CREATE TABLE aliases (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	alias  CHAR(33) NOT NULL UNIQUE,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);



