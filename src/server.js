const express = require('express');

const LinkedinClient = require('./LinkedinClient');

const logger = {
	info: message => console.info(message),
	error: error => console.error(error)
};

function createApp(options = {}) {
	let linkedinClient = options.linkedinClient || null;
	const getLinkedinClient = () => {
		if (!linkedinClient)
			linkedinClient = new LinkedinClient(options.clientOptions);
		return linkedinClient;
	};
	const app = express();
	app.logger = options.logger || logger;
	app.use(express.json({ limit: '16kb' }));

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
			const result = await getLinkedinClient().fetch(profileUrl);
			if (!result) {
				const message = 'The profile was not found.';
				return response.status(404).json(isVersionedApi ? {
					error: { code: 'PROFILE_NOT_FOUND', message }
				} : { error: message, result: null });
			}
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

	app.get('/request', profileHandler);
	app.post('/v1/profiles', profileHandler);
	return app;
}

module.exports = { createApp };

if (require.main === module) {
	const port = Number.parseInt(process.env.PORT || '8080', 10);
	const app = createApp();
	app.listen(port, () => logger.info(`Server started on http://localhost:${port}`));
}
