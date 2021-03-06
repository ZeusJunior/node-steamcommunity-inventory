const axios = require('axios');
const Bottleneck = require('bottleneck');

const Parser = require('./Inventory/Parser');

const isRateLimited = require('./Inventory/isRateLimited');

/**
 * @constant
 */
const DAY_IN_MILISECONDS = 24 * 60 * 60 * 1000;
const SECOND_IN_MILISECONDS = 1000;

/**
 * Handles inventory requests to SteamCommunity.
 */
class Inventory {
	/**
	 * @param {Object} options
	 * @param {string} options.steamID When passed with cookies,
	 * 	you don't have to rely on rate limit, steam lets you request your inventory freely
	 * @param {number} options.minTime @see https://github.com/SGrondin/bottleneck#constructor
	 * @param {number} options.maxConcurent @see https://github.com/SGrondin/bottleneck#constructor
	 * @param {number} options.reservoir @see https://github.com/SGrondin/bottleneck#constructor
	 * @param {number} options.reservoirRefreshAmount @see https://github.com/SGrondin/bottleneck#constructor
	 * @param {number} options.reservoirRefreshInverval @see https://github.com/SGrondin/bottleneck#constructor
	 * @param {'new'|'old'} options.method method we use for inventory
	 * @param {Function} options.formatter modifies econItem before being passed into then
	 * @param {Object} [options.headers]
	 */
	constructor(options = {}) {
		const {
			steamID, method = 'new', formatter, headers, cookies,
			minTime = 3, maxConcurent = SECOND_IN_MILISECONDS,
			// Afaik API allows 100,000 requests per day
			reservoir = 100000, reservoirRefreshAmount = DAY_IN_MILISECONDS,
			reservoirRefreshInverval = 100000,
		} = options;

		this.steamID = steamID;
		this.method = method;
		this.formatter = formatter;

		this.parser = new Parser(this);

		this.headers = headers;
		if (cookies) this.setCookies(cookies);

		this.request = axios.create();

		this.limiter = new Bottleneck({
			maxConcurent,
			minTime,
			reservoir,
			reservoirRefreshInverval,
			reservoirRefreshAmount,
		});
	}

	/**
	 * Sets cookies to instance
	 * NOTE: Current version only accepts cookies in for like
	 * 	@see https://github.com/DoctorMcKay/node-steam-user#websession
	 * @param {string[]} cookies
	 */
	setCookies(cookies) {
		this.cookies = cookies.join('; ');
	}

	/**
	 * A shorthand function used for requesting and limiting.
	 * @param {Object} options @see Inventory.prototype.getViaOldEndpoint
	 * 	@see Inventory.prototype.getViaNewEndpoint
	 */
	get(options) {
		const method = this.chooseMethod();

		const opts = { ...options };
		if (!opts.steamID) opts.steamID = this.steamID;

		/**
		 * Our SteamID is not rate limited when loggedIn.
		 */
		if (!isRateLimited(this, opts.steamID)) {
			return method(opts);
		}

		return this.limiter.schedule(() => method(opts));
	}

	/**
	 * Chooses method and binds it.
	 */
	chooseMethod() {
		if (this.method === 'old') {
			return Inventory.prototype.getViaOldEndpoint.bind(this);
		}

		return Inventory.prototype.getViaNewEndpoint.bind(this);
	}

	/**
	 * Gets inventory from old deprecated endpoint that has more data.
	 * @param {string} steamID
	 * @param {string} appID
	 * @param {string} contextID
	 * @param {number} [start] From which item do we start.
	 * @param {boolean} [tradableOnly=true]
	 * @param {Object[]} [inventory=[]] Only if you wanna append more items to it. Used for recursive.
	 * @return {Promise<EconItem[]>}
	 */
	getViaOldEndpoint({ steamID, appID, contextID, start = 0, tradableOnly = true, inventory = [] }) {
		const url = `https://steamcommunity.com/profiles/${steamID}/inventory/json/${appID}/${contextID}/`;

		return this.request
			.get(
				url,
				{
					...this.getHeaders(),
					params: {
						start,
						trading: tradableOnly ? 1 : 0,
					},
				},
			)
			.then(({ data }) => {
				if (!data.success) {
					return Promise.reject(
						new Error(`Unsuccessful request, ${data.message}`),
					);
				}

				inventory.push(
					...this.parser.toEconOld({
						assets: data.rgInventory,
						descriptions: data.rgDescriptions,
						formatter: this.formatter,
					}),
				);

				const { more } = data;
				const moreStart = data.more_start;

				if (more) {
					// `priority` is now higher so recursive function is prefered.
					return this.limiter.schedule({ priority: 4 }, () => this.getViaOldEndpoint(
						{
							steamID,
							appID,
							contextID,
							start: moreStart,
							tradableOnly,
							inventory,
						},
					));
				}

				return inventory;
			});
	}

	/**
	 * Gets inventory from new endpoint that has better rate limit but less data.
	 * @param {string} steamID
	 * @param {string} appID
	 * @param {string} contextID
	 * @param {string} [language=english]
	 * @return {Promise<EconItem[]>}
	 */
	getViaNewEndpoint({ steamID, appID, contextID, language = 'english' }) {
		const url = `https://steamcommunity.com/inventory/${steamID}/${appID}/${contextID}?l=english`;

		return this.request
			.get(
				url,
				{
					...this.getHeaders(),
					params: {
						l: language,
					},
				},
			)
			.then(({ data }) => {
				if (data.success !== 1) {
					return Promise.reject(
						new Error(`Unsuccessful request, ${data.message}`),
					);
				}

				return this.parser.toEconNew({
					assets: data.assets,
					descriptions: data.descriptions,
					formatter: this.formatter,
				});
			});
	}

	/**
	 * Returns cookies in object for iterators.
	 * @return {Object}
	 */
	getHeaders() {
		const { headers = {}, cookies } = this;

		return {
			...headers,
			// Adds cookies property only if we have 'em
			...(cookies ? { Cookie: cookies } : {}),
		};
	}
}

module.exports = Inventory;
