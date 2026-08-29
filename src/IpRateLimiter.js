const net = require('net');

const DEFAULT_LIMIT = 30;
const DEFAULT_GLOBAL_LIMIT = 100;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

function positiveInteger(value, name) {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new TypeError(`${name} must be a positive integer.`);
	return value;
}

function clientKey(request, keyGenerator) {
	if (keyGenerator) {
		const generated = keyGenerator(request);
		return typeof generated === 'string' && generated && generated.length <= 256
			? `custom:${generated}` : 'unknown';
	}
	const address = request.ip || request.socket && request.socket.remoteAddress || '';
	return normalizeIp(address);
}

function normalizeIp(value) {
	if (typeof value !== 'string' || !value || value.length > 128)
		return 'unknown';
	const address = value.split('%', 1)[0].toLowerCase();
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
	if (mapped && net.isIP(mapped[1]) === 4)
		return `ipv4:${mapped[1]}`;
	const version = net.isIP(address);
	if (version === 4)
		return `ipv4:${address}`;
	if (version !== 6)
		return 'unknown';
	const expanded = expandIpv6(address);
	return expanded ? `ipv6:${expanded.slice(0, 4).join(':')}::/64` : 'unknown';
}

function expandIpv6(value) {
	let address = value;
	const ipv4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
	if (ipv4Tail) {
		if (net.isIP(ipv4Tail[1]) !== 4)
			return null;
		const bytes = ipv4Tail[1].split('.').map(Number);
		const replacement = ((bytes[0] << 8) | bytes[1]).toString(16) + ':' +
			((bytes[2] << 8) | bytes[3]).toString(16);
		address = address.slice(0, -ipv4Tail[1].length) + replacement;
	}
	const halves = address.split('::');
	if (halves.length > 2)
		return null;
	const left = halves[0] ? halves[0].split(':') : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const missing = 8 - left.length - right.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1)
		return null;
	const parts = left.concat(Array(missing).fill('0'), right);
	if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part)))
		return null;
	return parts.map(part => Number.parseInt(part, 16).toString(16));
}

function setLimitHeaders(response, limit, remaining, resetAt) {
	response.setHeader('X-RateLimit-Limit', String(limit));
	response.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
	response.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
}

function rejectRequest(request, response, limit, resetAt, now) {
	const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
	setLimitHeaders(response, limit, 0, resetAt);
	response.setHeader('Retry-After', String(retryAfterSeconds));
	response.setHeader('Cache-Control', 'no-store');
	if (request.method === 'POST') {
		return response.status(429).json({
			error: {
				code: 'RATE_LIMITED',
				message: 'Too many profile requests. Try again later.',
				retryAfterSeconds
			}
		});
	}
	return response.status(429).json({
		error: 'RATE_LIMITED',
		result: null,
		retryAfterSeconds
	});
}

function createIpRateLimiter(options = {}) {
	const limit = positiveInteger(options.limit ?? DEFAULT_LIMIT, 'limit');
	const globalLimit = positiveInteger(options.globalLimit ?? DEFAULT_GLOBAL_LIMIT, 'globalLimit');
	const windowMs = positiveInteger(options.windowMs ?? DEFAULT_WINDOW_MS, 'windowMs');
	const maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries');
	const now = options.now || Date.now;
	const keyGenerator = options.keyGenerator;
	if (typeof now !== 'function' || keyGenerator !== undefined && typeof keyGenerator !== 'function')
		throw new TypeError('Rate limiter now and keyGenerator options must be functions.');
	const clients = new Map();
	let globalBucket = { count: 0, resetAt: 0 };

	return function ipRateLimiter(request, response, next) {
		const currentTime = now();
		if (globalBucket.resetAt <= currentTime)
			globalBucket = { count: 0, resetAt: currentTime + windowMs };
		if (globalBucket.count >= globalLimit) {
			response.setHeader('X-RateLimit-Scope', 'global');
			return rejectRequest(request, response, globalLimit, globalBucket.resetAt, currentTime);
		}
		const key = clientKey(request, keyGenerator);
		let bucket = clients.get(key);
		if (bucket && bucket.resetAt <= currentTime) {
			clients.delete(key);
			bucket = null;
		}

		if (!bucket) {
			while (clients.size) {
				const oldest = clients.entries().next().value;
				if (oldest[1].resetAt > currentTime)
					break;
				clients.delete(oldest[0]);
			}
			if (clients.size >= maxEntries) {
				const oldest = clients.values().next().value;
				return rejectRequest(request, response, limit,
					oldest ? oldest.resetAt : currentTime + windowMs, currentTime);
			}
			bucket = { count: 0, resetAt: currentTime + windowMs };
			clients.set(key, bucket);
		}

		if (bucket.count >= limit)
			return rejectRequest(request, response, limit, bucket.resetAt, currentTime);
		bucket.count += 1;
		globalBucket.count += 1;
		setLimitHeaders(response, limit, limit - bucket.count, bucket.resetAt);
		response.setHeader('X-RateLimit-Global-Remaining',
			String(Math.max(0, globalLimit - globalBucket.count)));
		return next();
	};
}

module.exports = { createIpRateLimiter };
module.exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
module.exports.DEFAULT_GLOBAL_LIMIT = DEFAULT_GLOBAL_LIMIT;
module.exports.DEFAULT_WINDOW_MS = DEFAULT_WINDOW_MS;
module.exports.DEFAULT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
