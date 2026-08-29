const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;

function positiveInteger(value, name) {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new TypeError(`${name} must be a positive integer.`);
	return value;
}

function cacheKey(value) {
	if (typeof value !== 'string' || !value)
		throw new TypeError('The profile cache key must be a non-empty string.');
	return value;
}

function cacheValue(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('The cached profile must be an object.');
	return value;
}

class ProfileCache {
	constructor(options = {}) {
		this.ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs');
		this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries');
		this.now = options.now || Date.now;
		this.clone = options.clone || structuredClone;
		if (typeof this.now !== 'function' || typeof this.clone !== 'function')
			throw new TypeError('ProfileCache now and clone options must be functions.');
		this.entries = new Map();
	}

	get(key) {
		key = cacheKey(key);
		const entry = this.entries.get(key);
		if (!entry)
			return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return this.clone(entry.value);
	}

	set(key, value) {
		key = cacheKey(key);
		value = cacheValue(value);
		const now = this.now();
		this.removeExpired(now);
		this.entries.delete(key);
		while (this.entries.size >= this.maxEntries)
			this.entries.delete(this.entries.keys().next().value);
		this.entries.set(key, {
			value: this.clone(value),
			expiresAt: now + this.ttlMs
		});
		return this;
	}

	delete(key) {
		return this.entries.delete(cacheKey(key));
	}

	clear() {
		this.entries.clear();
	}

	get size() {
		this.removeExpired(this.now());
		return this.entries.size;
	}

	removeExpired(now) {
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now)
				this.entries.delete(key);
		}
	}
}

module.exports = ProfileCache;
module.exports.DEFAULT_TTL_MS = DEFAULT_TTL_MS;
module.exports.DEFAULT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
