const crypto = require('crypto');
const express = require('express');

const LinkedinClient = require('./LinkedinClient');
const ProfileCache = require('./ProfileCache');
const { createIpRateLimiter } = require('./IpRateLimiter');

const logger = {
	info: message => console.info(message),
	error: error => console.error(error)
};

function createApp(options = {}) {
	let linkedinClient = options.linkedinClient || null;
	const profileCache = options.profileCache || new ProfileCache(options.cacheOptions);
	const profileRateLimiter = options.profileRateLimiter || createIpRateLimiter(options.rateLimitOptions);
	const getLinkedinClient = () => {
		if (!linkedinClient)
			linkedinClient = new LinkedinClient(options.clientOptions);
		return linkedinClient;
	};
	const app = express();
	app.logger = options.logger || logger;
	if (options.trustProxy !== undefined)
		app.set('trust proxy', options.trustProxy);
	const jsonParser = express.json({ limit: '16kb' });

	app.get('/', (request, response) => response.json({
		name: 'LinkedIn Profile HTTP Client',
		transport: 'linkedin-voyager',
		endpoints: {
			health: 'GET /health',
			profile: 'POST /v1/profiles'
		}
	}));
	app.get('/health', (request, response) => response.json({ status: 'ok' }));

	async function profileHandler(request, response) {
		response.setHeader('Cache-Control', 'no-store');
		const isVersionedApi = request.method === 'POST';
		const profileUrl = request.method === 'POST' ? request.body && request.body.profileUrl :
			request.query.linkedinUrl;
		if (!profileUrl) {
			const message = 'A LinkedIn profile URL is required.';
			return response.status(400).json(isVersionedApi ? {
				error: { code: 'INVALID_REQUEST', message }
			} : { error: message, result: null });
		}
		try {
			const target = LinkedinClient.canonicalizeProfileUrl(profileUrl);
			const cached = profileCache.get(target.canonicalUrl);
			if (cached !== undefined) {
				if (cached.meta && typeof cached.meta === 'object')
					cached.meta.requestId = crypto.randomUUID();
				response.setHeader('X-Cache', 'HIT');
				return response.json(isVersionedApi ? cached : { error: null, result: cached });
			}
			const result = await getLinkedinClient().fetch(target.canonicalUrl);
			if (!result) {
				const message = 'The profile was not found.';
				return response.status(404).json(isVersionedApi ? {
					error: { code: 'PROFILE_NOT_FOUND', message }
				} : { error: message, result: null });
			}
			profileCache.set(target.canonicalUrl, result);
			response.setHeader('X-Cache', 'MISS');
			return response.json(isVersionedApi ? result : { error: null, result });
		} catch (error) {
			app.logger.error(error);
			const code = error.code || 'UPSTREAM_UNAVAILABLE';
			const status = code === 'INVALID_PROFILE_URL' ? 400 : code === 'PROFILE_NOT_FOUND' ? 404 :
				code === 'LINKEDIN_THROTTLED' ? 429 : code === 'LINKEDIN_SESSION_UNAVAILABLE' ||
				code === 'SERVICE_BUSY' ? 503 : code === 'UPSTREAM_TIMEOUT' ? 504 : 502;
			return response.status(status).json(isVersionedApi ? {
				error: { code, message: error.message }
			} : { error: code, result: null });
		}
	}

	app.get('/request', profileRateLimiter, profileHandler);
	app.post('/v1/profiles', profileRateLimiter, jsonParser, profileHandler);
	return app;
}

function trustProxyHops(value) {
	if (value === undefined || value === '')
		return undefined;
	if (!/^\d+$/.test(value))
		throw new Error('TRUST_PROXY_HOPS must be a positive integer.');
	const hops = Number(value);
	if (!Number.isSafeInteger(hops) || hops <= 0 || hops > 10)
		throw new Error('TRUST_PROXY_HOPS must be between 1 and 10.');
	return hops;
}

module.exports = { createApp };

if (require.main === module) {
	const port = Number.parseInt(process.env.PORT || '8080', 10);
	const app = createApp({ trustProxy: trustProxyHops(process.env.TRUST_PROXY_HOPS) });
	app.listen(port, () => logger.info(`Server started on http://localhost:${port}`));
}
